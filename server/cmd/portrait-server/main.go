package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"
	"portraitstudio/server/internal/auth"
	"portraitstudio/server/internal/httpapi"
	"portraitstudio/server/internal/store"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "init-admin" {
		if err := initAdmin(os.Args[2:]); err != nil {
			log.Fatal(err)
		}
		return
	}
	listen := flag.String("listen", "127.0.0.1:4137", "HTTP listener; must be a loopback IP and port")
	data := flag.String("data", "", "Dedicated persistent portrait library directory")
	version := flag.String("version", "development", "Version shown by healthz")
	label := flag.String("label", "Remote portrait library", "Library label displayed in the desktop client")
	authFile := flag.String("auth-file", os.Getenv("PORTRAIT_STUDIO_AUTH_FILE"), "Private admin hash JSON file outside the portrait library; may be uninitialized")
	flag.Parse()
	if flag.NArg() != 0 {
		log.Fatal("unexpected command-line arguments")
	}
	if *data == "" {
		log.Fatal("-data is required")
	}
	if err := adminEnvironment(); err != nil {
		log.Fatal(err)
	}
	if *authFile != "" && credentialInsideLibrary(*authFile, *data) {
		log.Fatal("admin authentication files must be outside the portrait library")
	}
	authManager, err := auth.Open(*authFile, auth.Options{PasswordHash: os.Getenv("PORTRAIT_STUDIO_ADMIN_PASSWORD_HASH")})
	if err != nil {
		log.Fatal(err)
	}
	if err := httpapi.LoopbackAddress(*listen); err != nil {
		log.Fatal(err)
	}
	library, err := store.Open(*data)
	if err != nil {
		log.Fatal(err)
	}
	defer library.Close()
	server := &http.Server{Addr: *listen, Handler: httpapi.New(library, httpapi.Options{Version: *version, LibraryLabel: *label, Auth: authManager}), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 5 * time.Minute, WriteTimeout: 5 * time.Minute, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(shutdown)
	go func() {
		<-shutdown
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()
	fmt.Printf("Portrait server %s listening at %s (loopback only)\n", *version, *listen)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func adminEnvironment() error {
	if username := os.Getenv("PORTRAIT_STUDIO_ADMIN_USERNAME"); username != "" && username != auth.Username {
		return errors.New("the platform has one fixed account named admin")
	}
	if _, exists := os.LookupEnv("PORTRAIT_STUDIO_ADMIN_PASSWORD"); exists {
		return errors.New("plaintext admin password environment variables are unsupported; initialize a private hash configuration")
	}
	return nil
}

func credentialInsideLibrary(file, data string) bool {
	dataPath, err := filepath.Abs(data)
	if err != nil {
		return true
	}
	if resolved, err := filepath.EvalSymlinks(dataPath); err == nil {
		dataPath = resolved
	}
	filePath, err := filepath.Abs(file)
	if err != nil {
		return true
	}
	if resolved, err := filepath.EvalSymlinks(filepath.Dir(filePath)); err == nil {
		filePath = filepath.Join(resolved, filepath.Base(filePath))
	}
	relative, err := filepath.Rel(dataPath, filePath)
	return err != nil || relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func initAdmin(args []string) error {
	flags := flag.NewFlagSet("init-admin", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	file := flags.String("auth-file", os.Getenv("PORTRAIT_STUDIO_AUTH_FILE"), "New private admin hash JSON file (parent directory must be owned by this user and mode 0700)")
	envFile := flags.String("env-file", "", "New private 0600 environment configuration containing an admin PHC hash")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || (*file == "") == (*envFile == "") {
		return errors.New("choose exactly one initialization destination: -auth-file or -env-file; no password arguments are accepted")
	}
	if err := adminEnvironment(); err != nil {
		return err
	}
	// Read only the controlling terminal. Piped stdin, files, command arguments,
	// and environment passwords are never consumed as credentials.
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil || !term.IsTerminal(int(tty.Fd())) {
		if tty != nil {
			tty.Close()
		}
		return errors.New("admin initialization requires an interactive local terminal with hidden password input")
	}
	defer tty.Close()
	password, err := readPasswordTTY(tty, "New admin password (at least 12 characters): ")
	if err != nil {
		return err
	}
	defer auth.Erase(password)
	if !auth.ValidPassword(password) {
		return errors.New("use a password of at least 12 characters and at most 1024 UTF-8 bytes, without control characters")
	}
	confirmation, err := readPasswordTTY(tty, "Confirm admin password: ")
	if err != nil {
		return err
	}
	defer auth.Erase(confirmation)
	if subtle.ConstantTimeCompare(password, confirmation) != 1 {
		return errors.New("the passwords did not match; no credential file was created")
	}
	if *envFile != "" {
		err = auth.InitializeEnv(*envFile, password)
	} else {
		err = auth.Initialize(*file, password)
	}
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Admin authentication initialized. Keep the private hash configuration outside the portrait library and restart the server to load it.")
	return nil
}

func readPasswordTTY(tty *os.File, prompt string) ([]byte, error) {
	fd := int(tty.Fd())
	state, err := term.GetState(fd)
	if err != nil {
		return nil, errors.New("could not read the private terminal")
	}
	defer term.Restore(fd, state)
	interrupts := make(chan os.Signal, 1)
	done := make(chan struct{})
	signal.Notify(interrupts, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(interrupts)
	defer close(done)
	go func() {
		select {
		case <-interrupts:
			_ = term.Restore(fd, state)
			os.Exit(1)
		case <-done:
		}
	}()
	if _, err := fmt.Fprint(tty, prompt); err != nil {
		return nil, errors.New("could not read the private terminal")
	}
	password, err := term.ReadPassword(fd)
	fmt.Fprintln(tty)
	if err != nil {
		return nil, errors.New("private password input was interrupted; no credential file was created")
	}
	return password, nil
}
