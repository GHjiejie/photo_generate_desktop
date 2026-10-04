"""Pure, fail-closed review of a dedicated Portrait Studio Caddy site.

This module neither reads files nor runs Caddy. The caller privately adapts both
the original and candidate, validates the candidate with Caddy, and performs a
compare-and-swap against original_sha256 before installing it. A successful
fixture proof alone is not evidence that an actual Caddy configuration works.
"""
from dataclasses import dataclass, field
import copy
import hashlib
import json
import math
import re


HOST = 'portrait-18-180-65-241.sslip.io'
PREFIX = '/portrait-studio/*'
STRIP_PREFIX = '/portrait-studio'
UPSTREAM = '127.0.0.1:4137'
MAX_BYTES = 8 * 1024 * 1024
HOSTNAME = re.compile(r'(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\Z')
GROUP = re.compile(r'group[0-9]+\Z')
PUBLIC_BLOCK = f'''{HOST} {{
    handle_path {PREFIX} {{
        reverse_proxy {UPSTREAM} {{
            header_up Host {UPSTREAM}
        }}
    }}
    handle {{
        respond 404
    }}
}}
'''


class ReviewError(Exception):
    """A stable safe code; never contains Caddy text, hashes or credentials."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code):
    if not condition:
        raise ReviewError(code)


@dataclass(frozen=True)
class ReviewCandidate:
    original_sha256: str
    candidate_sha256: str
    candidate: bytes = field(repr=False)
    public_block: str = PUBLIC_BLOCK


@dataclass(frozen=True)
class _Token:
    value: str
    kind: str


@dataclass
class _Node:
    header: list
    children: list | None


def _lex(text):
    tokens, index = [], 0
    while index < len(text):
        require(len(tokens) <= 100000, 'CADDY_REVIEW_LIMIT')
        char = text[index]
        if char in ' \t\r':
            index += 1
            continue
        if char == '\n':
            tokens.append(_Token('\n', 'newline'))
            index += 1
            continue
        if char == '#':
            end = text.find('\n', index)
            index = len(text) if end < 0 else end
            continue
        start = index
        if char == '"':
            index += 1
            while index < len(text):
                if text[index] == '\\':
                    index += 2
                elif text[index] == '"':
                    index += 1
                    require(index == len(text) or text[index].isspace() or text[index] == '#', 'CADDY_UNSUPPORTED_SYNTAX')
                    try:
                        value = json.loads(text[start:index])
                    except (ValueError, UnicodeError):
                        raise ReviewError('CADDY_UNSUPPORTED_SYNTAX') from None
                    require(isinstance(value, str), 'CADDY_UNSUPPORTED_SYNTAX')
                    tokens.append(_Token(value, 'word'))
                    break
                else:
                    index += 1
            else:
                raise ReviewError('CADDY_UNSUPPORTED_SYNTAX')
            continue
        require(char != '`', 'CADDY_UNSUPPORTED_SYNTAX')
        if char in '{}' and (index + 1 == len(text) or text[index + 1].isspace() or text[index + 1] == '#'):
            tokens.append(_Token(char, char))
            index += 1
            continue
        while index < len(text) and not text[index].isspace() and text[index] != '#':
            require(text[index] not in '"`', 'CADDY_UNSUPPORTED_SYNTAX')
            index += 1
        value = text[start:index]
        require('\\' not in value, 'CADDY_UNSUPPORTED_SYNTAX')
        require(value and (('{' not in value and '}' not in value) or re.fullmatch(r'[^{}]*(?:\{[A-Za-z0-9_.$:-]+\}[^{}]*)+', value)), 'CADDY_UNSUPPORTED_SYNTAX')
        tokens.append(_Token(value, 'word'))
        require(len(tokens) <= 100000, 'CADDY_REVIEW_LIMIT')
    return tokens


def _parse(text):
    tokens, position = _lex(text), 0
    def block(nested, depth):
        nonlocal position
        require(depth <= 32, 'CADDY_REVIEW_LIMIT')
        result, header = [], []
        while position < len(tokens):
            token = tokens[position]
            position += 1
            if token.kind == 'word':
                header.append(token.value)
            elif token.kind == '{':
                children = block(True, depth + 1)
                result.append(_Node(header, children))
                header = []
            elif token.kind in ('newline', '}'):
                if header:
                    result.append(_Node(header, None))
                    header = []
                if token.kind == '}':
                    require(nested, 'CADDY_UNSUPPORTED_SYNTAX')
                    return result
        require(not nested, 'CADDY_UNSUPPORTED_SYNTAX')
        if header:
            result.append(_Node(header, None))
        return result
    return block(False, 0)


def _nodes(nodes):
    for node in nodes:
        yield node
        if node.children is not None:
            yield from _nodes(node.children)


def build_candidate(original):
    """Append a fixed, publicly reviewable site without changing any old byte."""
    require(type(original) is bytes and 0 < len(original) <= MAX_BYTES, 'CADDY_REVIEW_LIMIT')
    try:
        text = original.decode('utf-8', errors='strict')
    except UnicodeError:
        raise ReviewError('CADDY_UNSUPPORTED_SYNTAX') from None
    require(not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', text), 'CADDY_UNSUPPORTED_SYNTAX')
    nodes = _parse(text)
    sites, global_seen = set(), False
    for position, node in enumerate(nodes):
        require(node.children is not None, 'CADDY_UNSUPPORTED_SITE')
        if not node.header:
            # The only supported global option cannot reorder or disable HTTPS.
            require(position == 0 and not global_seen and len(node.children) == 1, 'CADDY_UNSUPPORTED_GLOBAL')
            option = node.children[0]
            require(option.children is None and len(option.header) == 2 and option.header[0] == 'email'
                    and re.fullmatch(r'[^\s{}@,]+@[a-zA-Z0-9.-]+', option.header[1]), 'CADDY_UNSUPPORTED_GLOBAL')
            global_seen = True
            continue
        require(len(node.header) == 1 and HOSTNAME.fullmatch(node.header[0]), 'CADDY_UNSUPPORTED_SITE')
        host = node.header[0]
        require(host != HOST and host not in sites, 'CADDY_HOST_CONFLICT')
        sites.add(host)
    require(sites, 'CADDY_UNSUPPORTED_SITE')
    for node in _nodes(nodes):
        if not node.header:
            continue
        require(node.header[0] not in ('import', 'order'), 'CADDY_UNSUPPORTED_IMPORT_ORDER')
        require(not any('{$' in value for value in node.header), 'CADDY_UNSUPPORTED_ENVIRONMENT')
        require(not node.header[0].startswith('('), 'CADDY_UNSUPPORTED_SITE')
        require(not any(value == HOST for value in node.header), 'CADDY_HOST_CONFLICT')
        require(not any(value.startswith(STRIP_PREFIX) for value in node.header), 'CADDY_PREFIX_CONFLICT')
        host_offset = 1 if node.header[0] == 'host' else 2 if node.header[0].startswith('@') and len(node.header) > 1 and node.header[1] == 'host' else None
        if host_offset is not None:
            require(len(node.header) > host_offset and all(HOSTNAME.fullmatch(value) and value != HOST for value in node.header[host_offset:]), 'CADDY_UNSUPPORTED_HOST_MATCHER')
    candidate = original + b'\n\n' + PUBLIC_BLOCK.encode('ascii')
    require(len(candidate) <= MAX_BYTES, 'CADDY_REVIEW_LIMIT')
    return ReviewCandidate(hashlib.sha256(original).hexdigest(), hashlib.sha256(candidate).hexdigest(), candidate)


def _bounded_json(value):
    count = 0
    def walk(item, depth):
        nonlocal count
        count += 1
        require(depth <= 64 and count <= 200000, 'CADDY_REVIEW_LIMIT')
        if isinstance(item, dict):
            require(all(type(key) is str for key in item), 'CADDY_UNSUPPORTED_ADAPTED')
            for child in item.values():
                walk(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                walk(child, depth + 1)
        else:
            require(item is None or type(item) in (str, int, bool) or type(item) is float and math.isfinite(item), 'CADDY_UNSUPPORTED_ADAPTED')
    walk(value, 0)
    require(isinstance(value, dict), 'CADDY_UNSUPPORTED_ADAPTED')
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
    require(len(encoded) <= MAX_BYTES, 'CADDY_REVIEW_LIMIT')


def _servers(config):
    apps = config.get('apps')
    require(isinstance(apps, dict) and isinstance(apps.get('http'), dict), 'CADDY_UNSUPPORTED_ADAPTED')
    servers = apps['http'].get('servers')
    require(isinstance(servers, dict) and servers, 'CADDY_UNSUPPORTED_ADAPTED')
    for server in servers.values():
        require(isinstance(server, dict) and isinstance(server.get('routes'), list)
                and isinstance(server.get('listen'), list), 'CADDY_UNSUPPORTED_ADAPTED')
        for route in server['routes']:
            require(isinstance(route, dict), 'CADDY_UNSUPPORTED_ADAPTED')
            matches = route.get('match')
            require(isinstance(matches, list) and len(matches) == 1 and isinstance(matches[0], dict)
                    and set(matches[0]) == {'host'} and isinstance(matches[0]['host'], list)
                    and len(matches[0]['host']) == 1 and isinstance(matches[0]['host'][0], str)
                    and HOSTNAME.fullmatch(matches[0]['host'][0]) and route.get('terminal') is True, 'CADDY_UNSUPPORTED_HOST_SCOPE')
    return servers


def _linear_handlers(handles, depth=0):
    require(depth <= 16 and isinstance(handles, list) and handles, 'CADDY_INVALID_PUBLIC_ROUTE')
    result = []
    for handler in handles:
        require(isinstance(handler, dict), 'CADDY_INVALID_PUBLIC_ROUTE')
        if handler.get('handler') == 'subroute':
            require(set(handler) == {'handler', 'routes'} and isinstance(handler['routes'], list) and handler['routes'], 'CADDY_INVALID_PUBLIC_ROUTE')
            for route in handler['routes']:
                require(isinstance(route, dict) and set(route) == {'handle'}, 'CADDY_INVALID_PUBLIC_ROUTE')
                result.extend(_linear_handlers(route['handle'], depth + 1))
        else:
            result.append(handler)
    return result


def _public_route(route):
    require(set(route) == {'match', 'handle', 'terminal'} and route['match'] == [{'host': [HOST]}]
            and route['terminal'] is True, 'CADDY_INVALID_PUBLIC_ROUTE')
    handles = route['handle']
    require(isinstance(handles, list) and len(handles) == 1 and isinstance(handles[0], dict)
            and set(handles[0]) == {'handler', 'routes'} and handles[0]['handler'] == 'subroute', 'CADDY_INVALID_PUBLIC_ROUTE')
    entries = handles[0]['routes']
    require(isinstance(entries, list) and len(entries) == 2, 'CADDY_INVALID_PUBLIC_ROUTE')
    prefix, fallback = entries
    allowed = {'match', 'handle', 'group', 'terminal'}
    require(isinstance(prefix, dict) and set(prefix) <= allowed and prefix.get('match') == [{'path': [PREFIX]}], 'CADDY_INVALID_PUBLIC_ROUTE')
    require(isinstance(fallback, dict) and set(fallback) <= allowed - {'match'}, 'CADDY_INVALID_PUBLIC_ROUTE')
    require(all('terminal' not in entry or entry['terminal'] is True for entry in entries), 'CADDY_INVALID_PUBLIC_ROUTE')
    if 'group' in prefix or 'group' in fallback:
        require(isinstance(prefix.get('group'), str) and GROUP.fullmatch(prefix['group'])
                and prefix['group'] == fallback.get('group'), 'CADDY_INVALID_PUBLIC_ROUTE')
        groups = {prefix['group']}
    else:
        require(prefix.get('terminal') is True, 'CADDY_INVALID_PUBLIC_ROUTE')
        groups = set()
    target = _linear_handlers(prefix.get('handle'))
    require(len(target) == 2 and target[0] == {'handler': 'rewrite', 'strip_path_prefix': STRIP_PREFIX}, 'CADDY_INVALID_PUBLIC_ROUTE')
    require(target[1] == {'handler': 'reverse_proxy', 'upstreams': [{'dial': UPSTREAM}],
                          'headers': {'request': {'set': {'Host': [UPSTREAM]}}}}, 'CADDY_INVALID_PUBLIC_ROUTE')
    rejection = _linear_handlers(fallback.get('handle'))
    require(len(rejection) == 1 and set(rejection[0]) <= {'handler', 'status_code', 'body'}
            and rejection[0].get('handler') == 'static_response'
            and type(rejection[0].get('status_code')) in (int, str)
            and rejection[0]['status_code'] in (404, '404') and rejection[0].get('body', '') == '', 'CADDY_INVALID_PUBLIC_ROUTE')
    return groups


def _strip_new_tls(before, after):
    """Remove only the new literal certificate subject, never old TLS options."""
    before_tls = before['apps'].get('tls', {})
    tls = after['apps'].get('tls')
    if tls is None:
        return
    require(isinstance(tls, dict) and isinstance(before_tls, dict), 'CADDY_TLS_CHANGED')
    require(isinstance(before_tls.get('certificates', {}), dict) and isinstance(before_tls.get('automation', {}), dict), 'CADDY_TLS_CHANGED')
    certificates = tls.get('certificates')
    if certificates is not None:
        require(isinstance(certificates, dict), 'CADDY_TLS_CHANGED')
        automate = certificates.get('automate')
        if automate is not None:
            require(isinstance(automate, list) and all(isinstance(host, str) for host in automate)
                    and automate.count(HOST) <= 1, 'CADDY_TLS_CHANGED')
            if HOST in automate:
                certificates['automate'] = [host for host in automate if host != HOST]
                if not certificates['automate'] and 'automate' not in before_tls.get('certificates', {}):
                    del certificates['automate']
        if not certificates and 'certificates' not in before_tls:
            del tls['certificates']
    automation = tls.get('automation')
    if automation is not None:
        require(isinstance(automation, dict), 'CADDY_TLS_CHANGED')
        policies = automation.get('policies')
        if policies is not None:
            require(isinstance(policies, list), 'CADDY_TLS_CHANGED')
            retained = []
            appearances = 0
            for policy in policies:
                require(isinstance(policy, dict), 'CADDY_TLS_CHANGED')
                subjects = policy.get('subjects')
                if subjects is not None:
                    require(isinstance(subjects, list) and all(isinstance(host, str) for host in subjects), 'CADDY_TLS_CHANGED')
                    appearances += subjects.count(HOST)
                    if HOST in subjects:
                        policy['subjects'] = [host for host in subjects if host != HOST]
                        if not policy['subjects'] and set(policy) == {'subjects'}:
                            continue
                retained.append(policy)
            require(appearances <= 1, 'CADDY_TLS_CHANGED')
            automation['policies'] = retained
            if not retained and 'policies' not in before_tls.get('automation', {}):
                del automation['policies']
        if not automation and 'automation' not in before_tls:
            del tls['automation']
    if not tls and 'tls' not in before['apps']:
        del after['apps']['tls']


def _canonical_groups(config):
    result, groups = copy.deepcopy(config), {}
    def walk(item):
        if isinstance(item, dict):
            if 'group' in item and 'handle' in item:
                name = item['group']
                require(isinstance(name, str) and GROUP.fullmatch(name), 'CADDY_UNSUPPORTED_GROUP')
                if name not in groups:
                    groups[name] = f'group{len(groups)}'
                item['group'] = groups[name]
            for key in sorted(item):
                walk(item[key])
        elif isinstance(item, list):
            for child in item:
                walk(child)
    walk(result)
    return json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=True), set(groups)


def prove_adapted_unchanged(before, after):
    """Prove an exact dedicated route and unchanged old adapted semantics.

Only generated route-group names may change by one global bijection. Only the
new literal TLS certificate subject may be added to known automation fields.
No configuration values are included in exceptions or returned to the caller.
"""
    _bounded_json(before)
    _bounded_json(after)
    old_servers, new_servers = _servers(before), _servers(after)
    require(set(old_servers) == set(new_servers), 'CADDY_OLD_CONFIG_CHANGED')
    require(all(route['match'] != [{'host': [HOST]}] for server in old_servers.values() for route in server['routes']), 'CADDY_HOST_CONFLICT')
    selected = [(name, index, route) for name, server in new_servers.items() for index, route in enumerate(server['routes']) if route['match'] == [{'host': [HOST]}]]
    require(len(selected) == 1, 'CADDY_INVALID_PUBLIC_ROUTE')
    name, index, route = selected[0]
    require(':443' in new_servers[name]['listen'], 'CADDY_PUBLIC_HTTPS_REQUIRED')
    new_groups = _public_route(route)
    remaining = copy.deepcopy(after)
    del remaining['apps']['http']['servers'][name]['routes'][index]
    _strip_new_tls(before, remaining)
    old_value, _ = _canonical_groups(before)
    new_value, remaining_groups = _canonical_groups(remaining)
    require(not new_groups.intersection(remaining_groups), 'CADDY_INVALID_PUBLIC_ROUTE')
    require(old_value == new_value, 'CADDY_OLD_CONFIG_CHANGED')
