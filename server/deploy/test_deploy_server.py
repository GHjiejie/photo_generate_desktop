"""Local deterministic tests: no SSH, systemd, Caddy, sockets or server writes."""
import copy
import gzip
import io
import json
from pathlib import Path
import stat
import struct
import tarfile
import tempfile
import types
import unittest
from unittest import mock

import deploy_server as deploy


def adapted():
    auth={'handle':[{'handler':'authentication','providers':{'http_basic':{'accounts':[{'username':'fixture-user','password':'FAKE_FIXTURE_NOT_A_CREDENTIAL'}]}}}]}
    prefix={'match':[{'path':[deploy.PREFIX]}],'handle':[{'handler':'rewrite','strip_path_prefix':'/portrait-studio'},{'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:4137'}],'headers':{'request':{'set':{'Host':['127.0.0.1:4137']}}}}]}
    dashboard={'match':[{'host':[deploy.HOST]}],'terminal':True,'handle':[{'handler':'subroute','routes':[auth,prefix,{'handle':[{'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:8787'}]}]}]}]}
    return {'apps':{'http':{'servers':{'srv0':{'listen':[':443'],'routes':[dashboard]}}}}}


def fixture_library():
    files,items={},[]
    for identifier in range(1,101):
        relative=f'assets/images/{identifier}.png';data=f'bounded-test-image-{identifier}'.encode();files['photo_repo/'+relative]=data
        items.append({'id':identifier,'label':f'Portrait {identifier}','type':'photo','prompts':{'en':f'Full English prompt {identifier}','zh':f'完整中文提示词 {identifier}'},'revision':1,'mime':'image/png','image':f'{identifier}.png','imageRel':relative,'sha256':deploy.sha256(data),'size':len(data)})
    files['photo_repo/.portrait-studio/library.json']=json.dumps({'schemaVersion':1,'revision':3,'items':items},ensure_ascii=False).encode()
    return files


def write_archive(directory,files,extra=None):
    content=io.BytesIO()
    with tarfile.open(fileobj=content,mode='w:',format=tarfile.USTAR_FORMAT) as archive:
        for name,data in files.items():
            member=tarfile.TarInfo(name);member.size=len(data);member.mode=0o600;archive.addfile(member,io.BytesIO(data))
        if extra:
            member,data=extra;archive.addfile(member,io.BytesIO(data) if data is not None else None)
    raw=gzip.compress(content.getvalue(),mtime=0);path=directory/'fixture.tar.gz';path.write_bytes(raw)
    manifest={'schemaVersion':1,'root':'photo_repo','count':100,'revision':3,'archiveFormat':'tar.gz','files':[{'path':name,'size':len(data),'sha256':deploy.sha256(data)}for name,data in files.items()],'archiveSha256':deploy.sha256(raw),'archiveSize':len(raw),'totalSize':sum(map(len,files.values()))}
    return path,manifest


class CaddyParserTests(unittest.TestCase):
    def test_quoted_braces_comments_and_placeholders_preserve_other_sites(self):
        original=('''{\n    email fixture@example.invalid\n}\nother.example.invalid {\n respond "literal { braces } #quoted"\n}\n'''+deploy.HOST+''' {\n # ignored { }\n basic_auth {\n   "fixture-user" "FAKE_{QUOTED}_HASH"\n }\n reverse_proxy 127.0.0.1:8787 {\n  header_up X-Fixture "{http.request.uri}"\n }\n}\n''').encode()
        candidate=deploy.candidate_caddy(original)
        self.assertEqual(candidate.replace(('\n'+deploy.ROUTE).encode(),b'',1),original)
        self.assertEqual(candidate.count(b'handle_path /portrait-studio/*'),1)
    def test_reject_scoped_nested_missing_duplicate_and_shared_auth(self):
        variants=[f'{deploy.HOST} {{\n reverse_proxy 127.0.0.1:1\n}}',f'{deploy.HOST} {{\n basic_auth /lite* {{\n u FAKE\n }}\n}}',f'{deploy.HOST} {{\n route {{\n basic_auth {{\n u FAKE\n }}\n }}\n}}',f'{deploy.HOST}, other.invalid {{\n basic_auth {{\n u FAKE\n }}\n}}',f'{deploy.HOST} {{\n basic_auth {{\n u FAKE\n }}\n basic_auth {{\n u FAKE\n }}\n}}']
        for fixture in variants:
            with self.subTest(fixture=fixture),self.assertRaises(deploy.DeploymentError):deploy.candidate_caddy(fixture.encode())
    def test_reject_import_custom_order_unknown_placeholder_and_existing_prefix(self):
        base=f'{deploy.HOST} {{\n basic_auth {{\n u FAKE\n }}\n %s\n}}'
        variants=[base%'import unknown',base%'handle_path /portrait-studio/* {\n respond 404\n }','{\n order basic_auth after reverse_proxy\n}\n'+base%'reverse_proxy 127.0.0.1:1',base.replace(deploy.HOST,'{$HOST}')%'reverse_proxy 127.0.0.1:1']
        for fixture in variants:
            with self.subTest(fixture=fixture),self.assertRaises(deploy.DeploymentError):deploy.candidate_caddy(fixture.encode())
    def test_malformed_quotes_braces_and_raw_strings_fail_closed(self):
        for fixture in ('}', '{\n',f'{deploy.HOST} {{\n respond "unclosed',f'{deploy.HOST} {{\n respond `raw`\n}}'):
            with self.subTest(fixture=fixture),self.assertRaises(deploy.DeploymentError):deploy.parse_caddy(fixture)


class AdaptedAuthTests(unittest.TestCase):
    def routes(self,config):return config['apps']['http']['servers']['srv0']['routes'][0]['handle'][0]['routes']
    def test_valid_direct_and_grouped_prefix(self):
        deploy.prove_adapted_auth(adapted());config=adapted();routes=self.routes(config);routes[1]={'handle':[{'handler':'subroute','routes':[routes[1]]}]};deploy.prove_adapted_auth(config)
    def test_reject_auth_after_prefix_and_scoped_auth(self):
        for scoped in (False,True):
            config=adapted();routes=self.routes(config)
            if scoped:routes[0]['match']=[{'path':['/lite*']}]
            else:routes[0],routes[1]=routes[1],routes[0]
            with self.assertRaises(deploy.DeploymentError):deploy.prove_adapted_auth(config)
    def test_reject_earlier_wildcard_host_and_catchall(self):
        for matcher in ([{'host':['*.sslip.io']}],None,[{'host':[deploy.HOST]}]):
            config=adapted();server=config['apps']['http']['servers']['srv0'];earlier={'handle':[{'handler':'static_response','body':'bypass'}]}
            if matcher is not None:earlier['match']=matcher
            server['routes'].insert(0,earlier)
            with self.assertRaises(deploy.DeploymentError):deploy.prove_adapted_auth(config)
    def test_reject_shared_host_nonterminal_and_missing_accounts(self):
        for variant in ('shared','nonterminal','accounts'):
            config=adapted();route=config['apps']['http']['servers']['srv0']['routes'][0]
            if variant=='shared':route['match'][0]['host'].append('other.invalid')
            elif variant=='nonterminal':route['terminal']=False
            else:self.routes(config)[0]['handle'][0]['providers']['http_basic']['accounts']=[]
            with self.assertRaises(deploy.DeploymentError):deploy.prove_adapted_auth(config)
    def test_reject_bad_proxy_duplicate_prefix_and_earlier_prefix_bypass(self):
        for variant in ('upstream','host','duplicate','bypass'):
            config=adapted();routes=self.routes(config)
            if variant=='upstream':routes[1]['handle'][1]['upstreams']=[{'dial':'127.0.0.1:4138'}]
            elif variant=='host':routes[1]['handle'][1]['headers']['request']['set']['Host']=['external.invalid']
            elif variant=='duplicate':routes.insert(2,copy.deepcopy(routes[1]))
            else:routes.insert(1,{'match':[{'path':['/*']}],'handle':[{'handler':'static_response','body':'bypass'}]})
            with self.assertRaises(deploy.DeploymentError):deploy.prove_adapted_auth(config)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup);self.directory=Path(self.temporary.name).resolve()
    def test_verified_100_item_archive_and_exclusive_extraction(self):
        files=fixture_library();archive,manifest=write_archive(self.directory,files);index=deploy.inspect_archive(archive,manifest);self.assertEqual(len(index['items']),100)
        destination=self.directory/'new-owned';destination.mkdir(mode=0o700);self.assertEqual(deploy.inspect_archive(archive,manifest,destination),index)
        for name,data in files.items():self.assertEqual((destination/name).read_bytes(),data);self.assertEqual(stat.S_IMODE((destination/name).stat().st_mode),0o600)
        with self.assertRaises(deploy.DeploymentError):deploy.inspect_archive(archive,manifest,destination)
    def test_reject_escape_absolute_duplicate_and_link_members(self):
        for name,kind in (('../escape',tarfile.REGTYPE),('/absolute',tarfile.REGTYPE),('photo_repo/assets/images/1.png',tarfile.REGTYPE),('photo_repo/link',tarfile.SYMTYPE),('photo_repo/device',tarfile.CHRTYPE)):
            member=tarfile.TarInfo(name);member.type=kind;member.size=1 if kind==tarfile.REGTYPE else 0;member.linkname='../escape' if kind==tarfile.SYMTYPE else ''
            archive,manifest=write_archive(self.directory,fixture_library(),(member,b'x' if member.size else None))
            with self.subTest(name=name),self.assertRaises(deploy.DeploymentError):deploy.inspect_archive(archive,manifest)
        self.assertFalse((self.directory.parent/'escape').exists())
    def test_reject_sidecar_and_archive_hash_size_schema_changes(self):
        archive,original=write_archive(self.directory,fixture_library())
        for change in ('schemaVersion','archiveSha256','archiveSize','totalSize','filehash','duplicate','null'):
            manifest=copy.deepcopy(original)
            if change=='schemaVersion':manifest[change]=2
            elif change=='archiveSha256':manifest[change]='0'*64
            elif change in ('archiveSize','totalSize'):manifest[change]+=1
            elif change=='filehash':manifest['files'][0]['sha256']='0'*64
            elif change=='duplicate':manifest['files'].append(copy.deepcopy(manifest['files'][0]))
            else:manifest['files'][0]['path']=None
            with self.subTest(change=change),self.assertRaises(deploy.DeploymentError):deploy.inspect_archive(archive,manifest)
    def test_reject_index_revision_count_image_reference_and_empty_prompt(self):
        for change in ('revision','count','path','prompt'):
            files=fixture_library();index=json.loads(files['photo_repo/.portrait-studio/library.json'])
            if change=='revision':index['revision']=4
            elif change=='count':index['items'].pop()
            elif change=='path':index['items'][0]['imageRel']='../escape.png'
            else:index['items'][0]['prompts']['zh']=''
            files['photo_repo/.portrait-studio/library.json']=json.dumps(index).encode();archive,manifest=write_archive(self.directory,files)
            with self.subTest(change=change),self.assertRaises(deploy.DeploymentError):deploy.inspect_archive(archive,manifest)
    def test_json_duplicates_and_nonfinite_numbers_rejected(self):
        for data in (b'{"id":1,"id":2}',b'{"value":NaN}',b'{"value":"\xff"}',b'{} {}'):
            with self.assertRaises(deploy.DeploymentError):deploy.strict_json(data)


class DeploymentGuardTests(unittest.TestCase):
    def test_static_linux_elf_and_dynamic_interpreter_rejected(self):
        data=bytearray(120);data[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HH',data,16,2,62);struct.pack_into('<Q',data,32,64);struct.pack_into('<HH',data,54,56,1);struct.pack_into('<I',data,64,1);deploy.check_static_elf(bytes(data))
        struct.pack_into('<I',data,64,3)
        with self.assertRaises(deploy.DeploymentError):deploy.check_static_elf(bytes(data))
        data[:4]=b'PE00'
        with self.assertRaises(deploy.DeploymentError):deploy.check_static_elf(bytes(data))
    def test_effective_systemd_user_fragment_and_dropins(self):
        valid=f'FragmentPath={deploy.UNIT}\nUser=ubuntu\nGroup=ubuntu\nDropInPaths=\n'.encode();deploy.prove_effective_unit(valid)
        for body in (valid.replace(b'User=ubuntu',b'User=root'),valid.replace(b'DropInPaths=',b'DropInPaths=/etc/custom.conf'),valid.replace(str(deploy.UNIT).encode(),b'/run/unknown.service')):
            with self.assertRaises(deploy.DeploymentError):deploy.prove_effective_unit(body)
    def state(self):
        return {'schemaVersion':1,'app':str(deploy.APP),'service':deploy.SERVICE,'caddy':str(deploy.CADDY),'status':'active','appDev':1,'appIno':2,'unitInstalled':True,'unitSha256':deploy.sha256(b'owned unit'),'caddyInstalled':True,'caddyBeforeSha256':deploy.sha256(b'before'),'caddyAfterSha256':deploy.sha256(b'after'),'serviceStarted':True}
    def app(self):return types.SimpleNamespace(st_dev=1,st_ino=2,st_uid=0,st_mode=stat.S_IFDIR|0o750)
    def test_rollback_guards_refuse_concurrent_operator_changes(self):
        value=self.state();deploy.rollback_guards(value,b'after',b'owned unit',self.app())
        for caddy,unit,info in ((b'operator edit',b'owned unit',self.app()),(b'after',b'operator unit',self.app()),(b'after',b'owned unit',types.SimpleNamespace(st_dev=1,st_ino=9,st_uid=0,st_mode=stat.S_IFDIR|0o750))):
            with self.assertRaises(deploy.DeploymentError):deploy.rollback_guards(value,caddy,unit,info)
    def test_rollback_accepts_known_postimage_before_saved_flag_and_unit_removal_retry(self):
        value=self.state();value['caddyInstalled']=False;deploy.rollback_guards(value,b'after',b'owned unit',self.app())
        value.update(unitRemovalPending=True,serviceStarted=False);deploy.rollback_guards(value,b'before',None,self.app())
        value['unitRemovalPending']=False
        with self.assertRaises(deploy.DeploymentError):deploy.rollback_guards(value,b'before',None,self.app())
    def test_partial_rollback_retries_both_caddy_and_daemon_reload_without_deleting_data(self):
        value=self.state();value.update(caddyInstalled=False,unitInstalled=False,status='rollback-partial',serviceStarted=False,caddyMode=0o644,caddyUid=0,caddyGid=0)
        info=types.SimpleNamespace(st_mode=stat.S_IFREG|0o644,st_uid=0,st_gid=0);private_info=types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=0,st_gid=0)
        def read(path,*args):return (b'before',private_info if path.name=='Caddyfile.before' else info)
        commands=mock.Mock();commands.run.return_value=b''
        with mock.patch.object(deploy,'read_file',side_effect=read),mock.patch.object(deploy,'no_links',return_value=self.app()),mock.patch.object(deploy.os.path,'lexists',return_value=False),mock.patch.object(deploy,'save_state'):
            deploy.rollback(value,commands)
        calls=[call.args[0] for call in commands.run.call_args_list];self.assertIn(['/usr/bin/systemctl','reload','caddy.service'],calls);self.assertIn(['/usr/bin/systemctl','daemon-reload'],calls);self.assertNotIn(['/usr/bin/systemctl','stop',deploy.SERVICE],calls);self.assertEqual(value['status'],'rolled-back')
    def test_rollback_recheck_refuses_caddy_change_before_reload(self):
        value=self.state();value.update(caddyInstalled=False,unitInstalled=False,serviceStarted=False,caddyMode=0o644,caddyUid=0,caddyGid=0)
        info=types.SimpleNamespace(st_mode=stat.S_IFREG|0o644,st_uid=0,st_gid=0);private_info=types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=0,st_gid=0)
        reads=iter([(b'before',info),(b'before',private_info),(b'operator edit',info)])
        commands=mock.Mock();commands.run.return_value=b''
        with mock.patch.object(deploy,'read_file',side_effect=lambda *args:next(reads)),mock.patch.object(deploy,'no_links',return_value=self.app()),mock.patch.object(deploy.os.path,'lexists',return_value=False),mock.patch.object(deploy,'save_state'),self.assertRaises(deploy.DeploymentError):deploy.rollback(value,commands)
        self.assertFalse(any(call.args[0][:2]==['/usr/bin/systemctl','reload'] for call in commands.run.call_args_list))
    def test_commands_use_unique_private_invocation_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            private=Path(temporary).resolve();first,second=deploy.Commands(private),deploy.Commands(private)
            with mock.patch.object(deploy.subprocess,'run',return_value=types.SimpleNamespace(returncode=0)):
                first.run(['/usr/bin/fixture-only'],'rollback');second.run(['/usr/bin/fixture-only'],'rollback')
            files=list(private.iterdir());self.assertEqual(len(files),4);self.assertTrue(all(stat.S_IMODE(file.stat().st_mode)==0o600 for file in files))


if __name__=='__main__':unittest.main()
