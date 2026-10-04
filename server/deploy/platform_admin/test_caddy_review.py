"""Offline fixtures only: no Caddy process, sockets, SSH or real configuration."""
import copy
import hashlib
import unittest

import caddy_review as review


DASHBOARD = 'dashboard-18-180-65-241.sslip.io'
MAIN = '18-180-65-241.sslip.io'
FAKE_HASH = 'FAKE_FIXTURE_NOT_A_CREDENTIAL'
ORIGINAL = (f'''{{
    email fixture@example.invalid
}}
{MAIN} {{
    reverse_proxy 127.0.0.1:8789
}}
{DASHBOARD} {{
    basic_auth {{
        fixture-user {FAKE_HASH}
    }}
    handle /lite* {{
        reverse_proxy 127.0.0.1:8788
    }}
    handle {{
        reverse_proxy 127.0.0.1:8787
    }}
}}
''').encode()


def old_route(host=DASHBOARD):
    return {'match': [{'host': [host]}], 'terminal': True, 'handle': [{'handler': 'subroute', 'routes': [
        {'handle': [{'handler': 'authentication', 'providers': {'http_basic': {'accounts': [{'username': 'fixture-user', 'password': FAKE_HASH}]}}}]},
        {'group': 'group0', 'match': [{'path': ['/lite*']}], 'handle': [{'handler': 'reverse_proxy', 'upstreams': [{'dial': '127.0.0.1:8788'}]}]},
        {'group': 'group0', 'handle': [{'handler': 'reverse_proxy', 'upstreams': [{'dial': '127.0.0.1:8787'}]}]}
    ]}]}


def public_route(group='group1', split=False):
    chain = [{'handler': 'rewrite', 'strip_path_prefix': review.STRIP_PREFIX},
             {'handler': 'reverse_proxy', 'upstreams': [{'dial': review.UPSTREAM}], 'headers': {'request': {'set': {'Host': [review.UPSTREAM]}}}}]
    prefix = {'match': [{'path': [review.PREFIX]}], 'handle': [{'handler': 'subroute', 'routes': [{'handle': chain}]}]}
    fallback = {'handle': [{'handler': 'subroute', 'routes': [{'handle': [{'handler': 'static_response', 'status_code': 404}]}]}]}
    if split:
        prefix['handle'][0]['routes'] = [{'handle': [handler]} for handler in chain]
    if group is not None:
        prefix['group'] = fallback['group'] = group
    else:
        prefix['terminal'] = True
    return {'match': [{'host': [review.HOST]}], 'terminal': True, 'handle': [{'handler': 'subroute', 'routes': [prefix, fallback]}]}


def configs():
    main = {'match': [{'host': [MAIN]}], 'terminal': True, 'handle': [{'handler': 'reverse_proxy', 'upstreams': [{'dial': '127.0.0.1:8789'}]}]}
    before = {'apps': {'http': {'servers': {'srv0': {'listen': [':443'], 'routes': [old_route(), main]}}}}, 'logging': {'logs': {'default': {'level': 'INFO'}}}}
    after = copy.deepcopy(before)
    after['apps']['http']['servers']['srv0']['routes'].append(public_route())
    return before, after


def entries(config):
    return config['apps']['http']['servers']['srv0']['routes'][-1]['handle'][0]['routes']


class CandidateTests(unittest.TestCase):
    def test_append_only_candidate_and_safe_immutable_review_values(self):
        candidate = review.build_candidate(ORIGINAL)
        self.assertTrue(candidate.candidate.startswith(ORIGINAL))
        self.assertEqual(candidate.candidate, ORIGINAL + b'\n\n' + review.PUBLIC_BLOCK.encode())
        self.assertEqual(candidate.original_sha256, hashlib.sha256(ORIGINAL).hexdigest())
        self.assertEqual(candidate.candidate_sha256, hashlib.sha256(candidate.candidate).hexdigest())
        self.assertEqual(candidate.public_block, review.PUBLIC_BLOCK)
        self.assertNotIn(FAKE_HASH, repr(candidate))
        self.assertNotIn('basic_auth', candidate.public_block)
        with self.assertRaises(AttributeError):
            candidate.candidate = b'changed'

    def test_comments_quoted_braces_and_old_placeholders_are_preserved(self):
        source = ORIGINAL.replace(b'fixture-user '+FAKE_HASH.encode(), b'"fixture-user" "FAKE_{QUOTED}_HASH"')
        source += b'other.example.invalid {\n # ignored { }\n respond "literal { } # quoted"\n header X-Fixture {http.request.uri}\n}\n'
        self.assertTrue(review.build_candidate(source).candidate.startswith(source))

    def test_existing_host_prefix_shared_alias_wildcard_and_catchall_refused(self):
        cases = [ORIGINAL + (review.HOST + ' {\n respond 404\n}\n').encode(),
                 ORIGINAL.replace(DASHBOARD.encode(), (DASHBOARD + ', alias.example.invalid').encode()),
                 ORIGINAL.replace(DASHBOARD.encode(), b'*.sslip.io'),
                 ORIGINAL.replace(DASHBOARD.encode(), b':443'),
                 ORIGINAL.replace(DASHBOARD.encode(), ('https://' + DASHBOARD).encode()),
                 ORIGINAL.replace(b'handle /lite*', b'handle /portrait-studio/*'),
                 ORIGINAL + b'other.invalid {\n @overlap host *.sslip.io\n respond 404\n}\n']
        for source in cases:
            with self.subTest(length=len(source)), self.assertRaises(review.ReviewError):
                review.build_candidate(source)

    def test_import_order_snippet_and_unknown_global_are_refused(self):
        for source in [ORIGINAL + b'import other.caddy\n', ORIGINAL.replace(b'email fixture@example.invalid', b'order reverse_proxy first'),
                       ORIGINAL + b'(shared) {\n respond 404\n}\n', ORIGINAL.replace(b'email fixture@example.invalid', b'admin off'),
                       ORIGINAL.replace(b'handle /lite*', b'import child.caddy\n handle /lite*'),
                       ORIGINAL.replace(b'handle /lite*', b'{$EXTRA_DIRECTIVES}\n handle /lite*'),
                       ORIGINAL.replace(b'handle /lite*', b'im\\port child.caddy\n handle /lite*')]:
            with self.subTest(length=len(source)), self.assertRaises(review.ReviewError):
                review.build_candidate(source)

    def test_malformed_input_limits_and_safe_error_details(self):
        for source in [b'', b'\xff', b'\0secret', b'}', b'{\n', b'host.invalid {\n respond "unclosed',
                       b'host.invalid {\n respond `raw`\n}\n', b'x' * (review.MAX_BYTES + 1), b'host.invalid {\n' * 34]:
            with self.assertRaises(review.ReviewError) as context:
                review.build_candidate(source)
            self.assertTrue(str(context.exception).startswith('CADDY_'))
            self.assertNotIn('secret', str(context.exception))


class AdaptedProofTests(unittest.TestCase):
    def test_new_prefix_and_fallback_preserve_old_basic_and_do_not_mutate_inputs(self):
        before, after = configs()
        originals = copy.deepcopy((before, after))
        self.assertIsNone(review.prove_adapted_unchanged(before, after))
        self.assertEqual((before, after), originals)
        self.assertEqual(after['apps']['http']['servers']['srv0']['routes'][0], before['apps']['http']['servers']['srv0']['routes'][0])

    def test_safe_generated_group_bijection_split_chain_and_new_host_position(self):
        before, after = configs()
        old_entries = after['apps']['http']['servers']['srv0']['routes'][0]['handle'][0]['routes']
        old_entries[1]['group'] = old_entries[2]['group'] = 'group52'
        after['apps']['http']['servers']['srv0']['routes'].insert(0, after['apps']['http']['servers']['srv0']['routes'].pop())
        after['apps']['http']['servers']['srv0']['routes'][0] = public_route('group51', split=True)
        review.prove_adapted_unchanged(before, after)

    def test_direct_terminal_prefix_without_group_is_supported(self):
        before, after = configs()
        after['apps']['http']['servers']['srv0']['routes'][-1] = public_route(None)
        review.prove_adapted_unchanged(before, after)

    def test_old_auth_route_order_headers_group_relations_and_global_settings_must_not_change(self):
        for change in ('auth', 'scoped-auth', 'old-order', 'old-host-order', 'header', 'group', 'global', 'tls-permission'):
            before, after = configs()
            old = after['apps']['http']['servers']['srv0']['routes'][0]['handle'][0]['routes']
            if change == 'auth':
                old[0]['handle'][0]['providers']['http_basic']['accounts'][0]['password'] = 'FAKE_CHANGED'
            elif change == 'scoped-auth':
                old[0]['match'] = [{'path': ['/lite*']}]
            elif change == 'old-order':
                old[1], old[2] = old[2], old[1]
            elif change == 'old-host-order':
                routes = after['apps']['http']['servers']['srv0']['routes']
                routes[0], routes[1] = routes[1], routes[0]
            elif change == 'header':
                old[1]['handle'][0]['headers'] = {'request': {'set': {'Authorization': ['FAKE_CHANGED']}}}
            elif change == 'group':
                old[2]['group'] = 'group2'
            elif change == 'global':
                after['logging']['logs']['default']['level'] = 'DEBUG'
            else:
                after['apps']['http']['servers']['srv0']['tls_connection_policies'] = [{'client_authentication': {'mode': 'request'}}]
            with self.subTest(change=change), self.assertRaises(review.ReviewError):
                review.prove_adapted_unchanged(before, after)

    def test_top_level_catchall_wildcard_alias_and_existing_newhost_refused(self):
        for matcher in (None, [{'host': ['*.sslip.io']}], [{'host': [DASHBOARD, MAIN]}], [{'host': [review.HOST]}]):
            before, after = configs()
            route = old_route()
            if matcher is None:
                del route['match']
            else:
                route['match'] = matcher
            before['apps']['http']['servers']['srv0']['routes'].insert(0, copy.deepcopy(route))
            after['apps']['http']['servers']['srv0']['routes'].insert(0, route)
            with self.subTest(matcher=matcher), self.assertRaises(review.ReviewError):
                review.prove_adapted_unchanged(before, after)

    def test_new_public_route_cannot_bypass_path_or_add_other_handlers_or_authorization(self):
        for change in ('path', 'extra-route', 'fallback-path', 'basic', 'file', 'other-upstream', 'no-host', 'auth-header', 'strip', 'fallback-status', 'group', 'host-alias', 'duplicate-host', 'http'):
            before, after = configs()
            prefix, fallback = entries(after)
            chain = prefix['handle'][0]['routes'][0]['handle']
            if change == 'path': prefix['match'][0]['path'] = ['/*']
            elif change == 'extra-route': entries(after).insert(0, {'handle': [{'handler': 'static_response', 'status_code': 200}]})
            elif change == 'fallback-path': fallback['match'] = [{'path': ['/other*']}]
            elif change == 'basic': chain.append({'handler': 'authentication', 'providers': {}})
            elif change == 'file': chain[1] = {'handler': 'file_server'}
            elif change == 'other-upstream': chain[1]['upstreams'][0]['dial'] = '127.0.0.1:8787'
            elif change == 'no-host': del chain[1]['headers']
            elif change == 'auth-header': chain[1]['headers']['request']['set']['Authorization'] = ['FAKE_FORGED']
            elif change == 'strip': chain[0]['strip_path_prefix'] = '/other'
            elif change == 'fallback-status': fallback['handle'][0]['routes'][0]['handle'][0]['status_code'] = 200
            elif change == 'group': fallback['group'] = 'group2'
            elif change == 'host-alias': after['apps']['http']['servers']['srv0']['routes'][-1]['match'][0]['host'].append('alias.invalid')
            elif change == 'duplicate-host': after['apps']['http']['servers']['srv0']['routes'].append(public_route('group3'))
            else: after['apps']['http']['servers']['srv0']['listen'] = [':80']
            with self.subTest(change=change), self.assertRaises(review.ReviewError):
                review.prove_adapted_unchanged(before, after)

    def test_explicit_new_certificate_subject_additions_preserve_old_tls_exactly(self):
        before, after = configs()
        before['apps']['tls'] = {'certificates': {'automate': [DASHBOARD]}, 'automation': {'policies': [{'subjects': [DASHBOARD], 'issuers': [{'module': 'acme', 'email': 'fixture@example.invalid'}]}]}}
        after['apps']['tls'] = copy.deepcopy(before['apps']['tls'])
        after['apps']['tls']['certificates']['automate'].append(review.HOST)
        after['apps']['tls']['automation']['policies'][0]['subjects'].append(review.HOST)
        review.prove_adapted_unchanged(before, after)
        before, after = configs()
        after['apps']['tls'] = {'certificates': {'automate': [review.HOST]}, 'automation': {'policies': [{'subjects': [review.HOST]}]}}
        review.prove_adapted_unchanged(before, after)

    def test_old_issuer_subject_order_catchall_policy_and_unknown_tls_settings_are_preserved(self):
        for change in ('issuer', 'subjects', 'old-order', 'catchall', 'new-policy-options', 'unknown', 'duplicate-new'):
            before, after = configs()
            before['apps']['tls'] = {'automation': {'policies': [{'subjects': [DASHBOARD, MAIN], 'issuers': [{'module': 'acme', 'email': 'fixture@example.invalid'}]}]}}
            after['apps']['tls'] = copy.deepcopy(before['apps']['tls'])
            policy = after['apps']['tls']['automation']['policies'][0]
            if change == 'issuer': policy['issuers'][0]['email'] = 'changed@example.invalid'
            elif change == 'subjects': policy['subjects'].remove(MAIN)
            elif change == 'old-order': policy['subjects'].reverse()
            elif change == 'catchall':
                del before['apps']['tls']['automation']['policies'][0]['subjects']
                policy['subjects'] = [review.HOST]
            elif change == 'new-policy-options': after['apps']['tls']['automation']['policies'].append({'subjects': [review.HOST], 'on_demand': True})
            elif change == 'unknown': after['apps']['tls']['unknown'] = True
            else: policy['subjects'].extend([review.HOST, review.HOST])
            with self.subTest(change=change), self.assertRaises(review.ReviewError):
                review.prove_adapted_unchanged(before, after)

    def test_no_server_additions_removals_or_unmanaged_group_collisions(self):
        for change in ('server', 'group', 'nonterminal', 'unknown-group', 'number-type'):
            before, after = configs()
            if change == 'server': after['apps']['http']['servers']['srv1'] = {'listen': [':443'], 'routes': []}
            elif change == 'group': entries(after)[0]['group'] = entries(after)[1]['group'] = 'group0'
            elif change == 'nonterminal': after['apps']['http']['servers']['srv0']['routes'][0]['terminal'] = False
            elif change == 'unknown-group': entries(after)[0]['group'] = entries(after)[1]['group'] = 'unknown'
            else: after['apps']['http']['servers']['srv0']['routes'][0]['terminal'] = 1
            with self.subTest(change=change), self.assertRaises(review.ReviewError):
                review.prove_adapted_unchanged(before, after)


if __name__ == '__main__':
    unittest.main()
