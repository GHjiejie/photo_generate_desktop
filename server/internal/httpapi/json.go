package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

func readLimited(reader io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		var oversized *http.MaxBytesError
		if errors.As(err, &oversized) {
			return nil, problem("TOO_LARGE", "The request body exceeds its permitted size.")
		}
		return nil, problem("INVALID_INPUT", "The request body is incomplete or unreadable.")
	}
	if int64(len(data)) > limit {
		return nil, problem("TOO_LARGE", "The request body exceeds its permitted size.")
	}
	return data, nil
}

func validateJSON(data []byte) error {
	if len(data) == 0 || !utf8.Valid(data) {
		return problem("INVALID_INPUT", "JSON must be non-empty valid UTF-8.")
	}
	// encoding/json otherwise silently replaces unpaired UTF-16 escapes, losing prompt text.
	inside := false
	for index := 0; index < len(data); index++ {
		if data[index] == '"' {
			inside = !inside
			continue
		}
		if !inside || data[index] != '\\' {
			continue
		}
		index++
		if index >= len(data) {
			break
		}
		if data[index] != 'u' || index+4 >= len(data) {
			continue
		}
		value, err := strconv.ParseUint(string(data[index+1:index+5]), 16, 16)
		if err != nil {
			continue
		}
		index += 4
		if value >= 0xdc00 && value <= 0xdfff {
			return problem("INVALID_INPUT", "JSON contains an unpaired Unicode surrogate.")
		}
		if value >= 0xd800 && value <= 0xdbff {
			if index+6 >= len(data) || data[index+1] != '\\' || data[index+2] != 'u' {
				return problem("INVALID_INPUT", "JSON contains an unpaired Unicode surrogate.")
			}
			low, err := strconv.ParseUint(string(data[index+3:index+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return problem("INVALID_INPUT", "JSON contains an unpaired Unicode surrogate.")
			}
			index += 6
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var visit func(int) error
	visit = func(depth int) error {
		if depth > 64 {
			return problem("INVALID_INPUT", "JSON nesting exceeds the supported limit.")
		}
		token, err := decoder.Token()
		if err != nil {
			return problem("INVALID_INPUT", "JSON is malformed.")
		}
		if delimiter, ok := token.(json.Delim); ok {
			switch delimiter {
			case '{':
				keys := make(map[string]bool)
				for decoder.More() {
					token, err := decoder.Token()
					if err != nil {
						return problem("INVALID_INPUT", "JSON is malformed.")
					}
					key, ok := token.(string)
					if !ok || keys[key] {
						return problem("INVALID_INPUT", "JSON object keys must be unique.")
					}
					keys[key] = true
					if err = visit(depth + 1); err != nil {
						return err
					}
				}
			case '[':
				for decoder.More() {
					if err = visit(depth + 1); err != nil {
						return err
					}
				}
			default:
				return problem("INVALID_INPUT", "JSON is malformed.")
			}
			_, err = decoder.Token()
			if err != nil {
				return problem("INVALID_INPUT", "JSON is malformed.")
			}
		}
		return nil
	}
	if err := visit(0); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return problem("INVALID_INPUT", "The JSON body must contain exactly one value.")
	}
	return nil
}

func decodeStrict(data []byte, target any) error {
	if err := validateJSON(data); err != nil {
		return err
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return problem("INVALID_INPUT", "Request metadata must be a JSON object.")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return problem("INVALID_INPUT", "JSON metadata contains unknown fields or invalid values.")
	}
	return nil
}

func readJSONBody(w http.ResponseWriter, r *http.Request, target any, limit int64) error {
	if err := contentType(r, "application/json"); err != nil {
		return err
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	data, err := readLimited(r.Body, limit)
	if err != nil {
		return err
	}
	return decodeStrict(data, target)
}
func decodeQuery(value string) (url.Values, error) {
	values, err := url.ParseQuery(value)
	if err != nil {
		return nil, problem("INVALID_INPUT", "The query string is invalid.")
	}
	return values, nil
}
func validUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, char := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if char != '-' {
				return false
			}
		} else if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	return true
}
func safeRelative(value string) bool {
	if value == "" || len(value) > 4096 || !utf8.ValidString(value) || strings.HasPrefix(value, "/") || strings.ContainsAny(value, "\\:") {
		return false
	}
	parts := strings.Split(value, "/")
	if len(parts) > 4 {
		return false
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || len(part) > 255 {
			return false
		}
		for _, char := range part {
			if char < 32 || char == 127 {
				return false
			}
		}
	}
	return true
}

func promptLength(value string) int {
	count := 0
	for _, character := range value {
		count++
		if character > 0xffff {
			count++
		}
	}
	return count
}
