#!/usr/bin/env python3
"""Reviewed administrative bootstrap; leaves the issue listener disabled."""
import argparse
import base64
import grp
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shlex
import stat
import subprocess


def command(args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs).stdout


def no_links(path):
    current = path
    while current != current.parent:
        if current.exists() and current.is_symlink():
            raise RuntimeError('symlink_path_preserved')
        current = current.parent


def managed_directory(path, uid=0, gid=0, mode=0o755):
    no_links(path)
    if path.exists():
        info = path.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode:
            raise RuntimeError('existing_directory_mismatch')
    else:
        path.mkdir(mode=mode)
        os.chown(path, uid, gid)
        path.chmod(mode)


def managed_file(path, data, uid=0, gid=0, mode=0o644):
    no_links(path)
    if path.exists():
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or path.read_bytes() != data or info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode:
            raise RuntimeError('existing_file_preserved')
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    os.chown(path, uid, gid)
    path.chmod(mode)


def ensure_group(name):
    try:
        return grp.getgrnam(name).gr_gid
    except KeyError:
        command(['/usr/sbin/groupadd', '--system', name])
        return grp.getgrnam(name).gr_gid


def ensure_user(name, home):
    try:
        account = pwd.getpwnam(name)
        if account.pw_dir != str(home) or account.pw_uid >= 1000:
            raise RuntimeError('existing_identity_preserved')
        return account
    except KeyError:
        command(['/usr/sbin/useradd', '--system', '--user-group', '--home-dir', str(home), '--shell', '/bin/sh', '--password', '*', name])
        return pwd.getpwnam(name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--configuration', type=Path, required=True)
    parser.add_argument('--coding-user', required=True)
    parser.add_argument('--backend-socket', type=Path, required=True)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--stage-only', action='store_true', help='Verify and copy immutable release files without changing service configuration')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', args.coding_user):
        raise RuntimeError('invalid_account')
    raw = (args.bundle / 'release-manifest.json').read_bytes()
    if hashlib.sha256(raw).hexdigest() != args.manifest_sha256:
        raise RuntimeError('manifest_mismatch')
    manifest = json.loads(raw)
    if manifest['schemaVersion'] != '1.0' or not re.fullmatch(r'[a-f0-9]{40}', manifest['revision']) or manifest['nodeVersion'] != '24.22.0':
        raise RuntimeError('manifest_invalid')
    inputs = {}
    for entry in manifest['files']:
        name = entry['path']
        if name in inputs or PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts or not re.fullmatch(r'[A-Za-z0-9_./@+ -]+', name):
            raise RuntimeError('manifest_invalid')
        path = args.bundle / 'files' / name
        no_links(path)
        if not path.is_file() or path.stat().st_nlink != 1 or path.stat().st_size != entry['size'] or entry['size'] > 160 * 1024 * 1024:
            raise RuntimeError('artifact_invalid')
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise RuntimeError('artifact_invalid')
        inputs[name] = (data, entry['executable'])
    for required in ['bin/node', 'apps/cli/main.ts', 'apps/target-helper/main.ts', 'schemas/config.schema.json', 'artifacts/action-self-build.json', 'artifacts/provider-github.json']:
        if required not in inputs:
            raise RuntimeError('incomplete_release')
    spec = json.loads(args.configuration.read_text())
    coding = pwd.getpwnam(args.coding_user)
    if spec['configuration']['enabled']:
        raise RuntimeError('bootstrap_must_be_disabled')
    if args.dry_run:
        print(json.dumps({'schemaVersion': '1.0', 'code': 'administrative_step_validated', 'files': len(inputs), 'enabled': False}))
        return
    if os.geteuid() != 0:
        raise RuntimeError('administrative_access_required')
    os.umask(0o077)
    release = Path('/opt/labstride/releases') / manifest['revision']
    for directory in [Path('/opt/labstride'), Path('/opt/labstride/releases'), release]:
        managed_directory(directory)
    for name, (data, executable) in inputs.items():
        output = release / name
        for parent in reversed(output.parent.parents):
            if parent != release and release in parent.parents:
                managed_directory(parent)
        if output.parent != release:
            managed_directory(output.parent)
        managed_file(output, data, mode=0o755 if executable else 0o644)
    managed_file(release / 'release-manifest.json', raw)
    if args.stage_only:
        print(json.dumps({'schemaVersion': '1.0', 'code': 'release_staged', 'revision': manifest['revision'], 'servicesChanged': False}))
        return
    for directory in [Path('/etc/labstride'), Path('/var/lib/labstride'), Path('/srv/labstride')]:
        managed_directory(directory)
    coordinator = ensure_user('labstride_coord', Path('/var/lib/labstride/coordinator'))
    helper = ensure_user('labstride_helper', Path('/var/lib/labstride/helper-home'))
    report_directory = Path('/var/lib/labstride/bridge-reports')
    managed_directory(report_directory, coding.pw_uid, coding.pw_gid, 0o700)
    work_gid, bridge_gid = ensure_group('labstride_work'), ensure_group('labstride_bridge')
    for user, groups in [(args.coding_user, 'labstride_work,labstride_bridge'), (helper.pw_name, 'labstride_work'), (coordinator.pw_name, 'labstride_bridge')]:
        command(['/usr/sbin/usermod', '-aG', groups, user])
    source_root = Path('/srv/labstride/workspaces')
    managed_directory(source_root, helper.pw_uid, work_gid, 0o750)
    # Named UID ACLs apply to the already running coding daemon. Changing its
    # supplementary groups would otherwise require interrupting existing chats.
    command(['/usr/bin/setfacl', '-m', f'u:{coding.pw_uid}:rx,u:{coordinator.pw_uid}:rx,d:u::rwx,d:u:{coding.pw_uid}:rwx,d:u:{coordinator.pw_uid}:rx,d:g::---,d:m::rwx,d:o::---', str(source_root)])
    state = Path(coordinator.pw_dir)
    managed_directory(state, coordinator.pw_uid, coordinator.pw_gid, 0o700)
    managed_directory(Path('/var/lib/labstride/helper'), helper.pw_uid, helper.pw_gid, 0o700)
    managed_directory(Path(helper.pw_dir))
    managed_directory(Path(helper.pw_dir) / '.ssh')
    enrollment = state / 'enrollment'
    managed_directory(enrollment, coordinator.pw_uid, coordinator.pw_gid, 0o700)
    secrets = state / 'secrets'
    managed_directory(secrets, coordinator.pw_uid, coordinator.pw_gid, 0o700)
    for reference, credential in spec['credentials'].items():
        original = Path(credential if isinstance(credential, str) else credential['keyFile'])
        no_links(original)
        if original.stat().st_mode & 0o077 or not original.is_file() or original.stat().st_nlink != 1:
            raise RuntimeError('credential_file_not_private')
        installed = secrets / hashlib.sha256(reference.encode()).hexdigest()
        managed_file(installed, original.read_bytes(), coordinator.pw_uid, coordinator.pw_gid, 0o600)
        if isinstance(credential, str):
            spec['credentials'][reference] = str(installed)
        else:
            credential['keyFile'] = str(installed)
            # Preserve the original file but withdraw coding-user access to the
            # same App private key now entrusted to the protected coordinator.
            os.chown(original, 0, 0)
            original.chmod(0o600)
    private_key = secrets / 'helper_ed25519'
    if not private_key.exists():
        command(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(private_key)])
        os.chown(private_key, coordinator.pw_uid, coordinator.pw_gid)
        os.chown(Path(str(private_key) + '.pub'), coordinator.pw_uid, coordinator.pw_gid)
    no_links(private_key)
    helper_launcher = release / 'bin/helper'
    launch = '#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/bin:/bin HOME=' + shlex.quote(helper.pw_dir) + ' ' + shlex.quote(str(release / 'bin/node')) + ' ' + shlex.quote(str(release / 'apps/target-helper/main.ts')) + ' /etc/labstride/helper.json\n'
    managed_file(helper_launcher, launch.encode(), mode=0o755)
    public_key = Path(str(private_key) + '.pub').read_text().strip()
    managed_file(Path(helper.pw_dir) / '.ssh/authorized_keys', ('restrict,command="' + str(helper_launcher) + '" ' + public_key + '\n').encode())
    info = source_root.stat()
    node = str(release / 'bin/node')
    # Linux mount identity is read through an open directory descriptor.
    fd = os.open(source_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        mount_id = int(re.search(r'^mnt_id:\s+(\d+)$', Path('/proc/self/fdinfo/' + str(fd)).read_text(), re.M)[1])
    finally:
        os.close(fd)
    root_identity = {'device': info.st_dev, 'inode': info.st_ino, 'mountId': mount_id, 'uid': helper.pw_uid}
    target_id, root_id = spec['targetId'], spec['rootId']
    repository = spec['policy']['repositories'][0]
    if len(spec['policy']['repositories']) != 1:
        raise RuntimeError('bootstrap_supports_one_repository')
    helper_policy = {'schemaVersion': '2.0', 'installationId': spec['configuration']['installationId'], 'targetId': target_id, 'targetRevision': 1,
                     'helperUid': helper.pw_uid, 'codingUid': coding.pw_uid, 'codingGid': work_gid, 'stateDir': '/var/lib/labstride/helper',
                     'roots': [{'id': root_id, 'path': str(source_root), 'identity': root_identity}],
                     'sources': [{'repositoryId': repository['id'], 'repository': repository['name'], 'gitUrl': 'https://github.com/' + repository['name'] + '.git', 'apiUrl': 'https://api.github.com/repos/' + repository['name'], 'credentialFile': None}]}
    spec['rootMappingFile'] = '/etc/labstride/root-mapping.json'
    managed_file(Path(spec['rootMappingFile']), (json.dumps({'schemaVersion':'1.0','sourceRoot':str(source_root),'targetId':target_id,'rootId':root_id,'identity':root_identity}) + '\n').encode(), gid=coordinator.pw_gid, mode=0o640)
    managed_file(Path('/etc/labstride/helper.json'), (json.dumps(helper_policy, indent=2) + '\n').encode(), gid=helper.pw_gid, mode=0o640)
    host_key = Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().strip().split()
    if host_key[0] != 'ssh-ed25519':
        raise RuntimeError('local_host_key_unavailable')
    enrolled = {'schemaVersion': '1.0', 'installationId': spec['configuration']['installationId'], 'targetId': target_id, 'revision': 1,
                'host': '127.0.0.1', 'port': 22, 'user': helper.pw_name, 'hostKey': ' '.join(host_key[:2]), 'identityFile': str(private_key),
                'helperCommand': str(helper_launcher), 'rootIds': [root_id], 'timeoutMs': 30000}
    enrollment_input = {'enrollment': enrolled, 'expectedRevision': 0, 'actorId': 'local-administrator', 'reason': 'Reviewed local source-only installation'}
    enrollment_file = state / 'enrollment-input.json'
    managed_file(enrollment_file, (json.dumps(enrollment_input) + '\n').encode(), coordinator.pw_uid, coordinator.pw_gid, 0o600)
    database = enrollment / 'enrollments.sqlite'
    if not database.exists():
        connector_configuration = json.loads(command(['/usr/sbin/runuser', '-u', coordinator.pw_name, '--', node, str(release / 'scripts/enroll_ssh_target.ts'), str(enrollment), str(enrollment_file)]))
    else:
        import sqlite3
        with sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True) as connection:
            row = connection.execute('SELECT payload,digest FROM enrollments WHERE target_id=? AND revision=1', (target_id,)).fetchone()
        if not row or json.loads(row[0]) != enrolled:
            raise RuntimeError('existing_enrollment_preserved')
        connector_configuration = {'enrollmentDirectory': str(enrollment), 'targetId': target_id, 'revision': 1, 'digest': row[1]}
    spec.update({'stateDirectory': str(state), 'sourceRoot': str(source_root), 'revision': manifest['revision']})
    spec['agent']['bridgeSocket'] = '/run/labstride-bridge/control.sock'
    spec['configuration']['targets'][target_id] = {'connector': 'labstride.connector.ssh', 'configuration': connector_configuration}
    for pin in spec['lock']['extensions']:
        package = {'labstride.connector.ssh': 'connector-ssh', 'labstride.workspace-create': 'action-workspace-create', 'labstride.self-build': 'action-self-build', 'labstride.github.native': 'provider-github'}[pin['id']]
        artifact = release / 'artifacts' / (package + '.json')
        metadata = json.loads(artifact.read_bytes())['manifest']
        pin.update({'artifactPath': str(artifact), 'integrity': hashlib.sha256(artifact.read_bytes()).hexdigest(), 'version': metadata['version'], 'permissions': metadata['permissions'], 'capabilities': metadata['capabilities']})
        if pin['id'] == 'labstride.connector.ssh':
            pin['configuration'] = connector_configuration
        if pin['id'] == 'labstride.self-build':
            pin['configuration'] = {key: spec[key] for key in ['agent', 'sourceRoot', 'rootId', 'baseBranch', 'requiredWorkflows']}
    spec['configuration']['extensions'] = [{key: pin[key] for key in ['id', 'version', 'integrity']} for pin in spec['lock']['extensions']]
    for grant in spec['policy']['grants']:
        grant['actionVersion'] = next(pin['version'] for pin in spec['lock']['extensions'] if pin['id'] == grant['actionId'])
    managed_file(Path('/etc/labstride/installation.json'), (json.dumps(spec, indent=2) + '\n').encode(), gid=coordinator.pw_gid, mode=0o640)
    bridge_policy = {'schemaVersion': '1.0', 'socket': spec['agent']['bridgeSocket'], 'backendSocket': str(args.backend_socket), 'backendVersion': spec['agent']['backendVersion'],
                     'sourceRoot': str(source_root), 'helperUid': helper.pw_uid, 'stateDirectory': '/run/labstride-bridge', 'reportDirectory': str(report_directory)}
    managed_file(Path('/etc/labstride/bridge.json'), (json.dumps(bridge_policy, indent=2) + '\n').encode(), gid=bridge_gid, mode=0o640)
    cli = release / 'apps/cli/main.ts'
    coordinator_unit = f'''[Unit]
Description=Labstride coordinator
After=network-online.target labstride-bridge.service
Wants=network-online.target labstride-bridge.service
[Service]
User={coordinator.pw_name}
Group={coordinator.pw_name}
SupplementaryGroups=labstride_bridge labstride_work
UMask=0077
ExecStart={node} {cli} serve --config /etc/labstride/installation.json
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={state}
[Install]
WantedBy=multi-user.target
'''
    bridge_unit = f'''[Unit]
Description=Labstride coding-user bridge to existing Codex daemon
After=network.target
[Service]
User={args.coding_user}
Group=labstride_bridge
SupplementaryGroups=labstride_work
UMask=0007
RuntimeDirectory=labstride-bridge
RuntimeDirectoryMode=0750
ExecStart={node} {cli} bridge /etc/labstride/bridge.json
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
'''
    managed_file(Path('/etc/systemd/system/labstride.service'), coordinator_unit.encode())
    managed_file(Path('/etc/systemd/system/labstride-bridge.service'), bridge_unit.encode())
    launcher = '#!/bin/sh\nexec /usr/sbin/runuser -u labstride_coord -- ' + shlex.quote(node) + ' ' + shlex.quote(str(cli)) + ' "$@"\n'
    managed_file(Path('/usr/local/bin/labstride'), launcher.encode(), mode=0o755)
    command(['/usr/bin/systemd-analyze', 'verify', '/etc/systemd/system/labstride.service', '/etc/systemd/system/labstride-bridge.service'])
    command(['/usr/bin/systemctl', 'daemon-reload'])
    print(json.dumps({'schemaVersion': '1.0', 'code': 'installed_disabled', 'revision': manifest['revision'], 'servicesStarted': False,
                      'next': 'Run scripts/activate_local.py for service-identity checks, then repeat with --apply for checked activation.'}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if re.fullmatch(r'[a-z_]{1,100}', str(error)) else 'administrative_step_failed'
        raise SystemExit(code)
