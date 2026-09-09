"""Trusted entrypoint. The claim init container alone receives Kubernetes credentials.

Leases deliberately never expire. Gateway releases them only after the owning pod has
terminated (or is absent), avoiding split-brain publication during an API/network outage.
"""
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import urllib.request
import urllib.error

WORK = Path('/work')
CONFIG = Path('/config/config.json')


def claim():
    WORK.mkdir(exist_ok=True)
    token_dir = Path('/kube')
    ns = os.environ['POD_NAMESPACE']
    uid = os.environ['POD_UID']
    name = os.environ['BUILD_LOCK']
    api = 'https://' + os.environ['KUBERNETES_SERVICE_HOST'] + ':' + os.environ.get('KUBERNETES_SERVICE_PORT', '443')
    url = api + '/apis/coordination.k8s.io/v1/namespaces/' + ns + '/leases'
    ctx = ssl.create_default_context(cafile=str(token_dir / 'ca.crt'))
    headers = {'Authorization': 'Bearer ' + (token_dir / 'token').read_text().strip(), 'Content-Type': 'application/json'}
    body = {'apiVersion': 'coordination.k8s.io/v1', 'kind': 'Lease',
            'metadata': {'name': name, 'labels': {'tessark.io/build-lock': 'true'}},
            'spec': {'holderIdentity': uid}}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, json.dumps(body).encode(), headers, method='POST'), context=ctx, timeout=15):
            pass
    except urllib.error.HTTPError as error:
        if error.code != 409:
            raise
        with urllib.request.urlopen(urllib.request.Request(url + '/' + name, headers=headers), context=ctx, timeout=15) as response:
            lease = json.load(response)
        # A response lost after creation is safely retryable by the same pod.
        if lease['spec']['holderIdentity'] != uid:
            (WORK / 'skipped').write_text('Another run holds this build lock.')
    (WORK / 'claimed').touch()


def inside(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('Path escapes the build context')
    return path


def execute(args, env=None):
    # Never use a shell or print arguments which may contain user configuration.
    subprocess.run(args, check=True, env=env)


def build():
    result = {'status': 'failed', 'stage': 'prepare'}
    try:
        if not (WORK / 'claimed').exists():
            raise ValueError('Build lock was not acquired')
        if (WORK / 'skipped').exists():
            result.update(status='skipped', error='Another run holds this build lock.')
            return 0
        config = json.loads(CONFIG.read_text())
        ca = Path('/config/ca.crt')
        env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
        # Hashed CA directories are loaded lazily by OpenSSL. Read the actual PEM
        # bundle instead of get_ca_certs(), which can be empty before a connection.
        bundle = WORK / 'ca-bundle.crt'
        public_roots = Path('/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem')
        bundle.write_bytes(public_roots.read_bytes() + b'\n' + (ca.read_bytes() if ca.exists() else b''))
        env['GIT_SSL_CAINFO'] = str(bundle)
        context = WORK / 'context'
        context.mkdir(exist_ok=True)
        if config['sourceKind'] == 'git':
            execute(['git', 'init', str(context)], env)
            execute(['git', '-C', str(context), '-c', 'protocol.file.allow=never', 'fetch', '--depth=1', '--', config['gitUrl'], config['gitRef']], env)
            execute(['git', '-C', str(context), 'checkout', '--detach', 'FETCH_HEAD'], env)
            result['commit'] = subprocess.check_output(['git', '-C', str(context), 'rev-parse', 'HEAD'], text=True).strip()
            context = inside(context, config['contextPath'])
            dockerfile = inside(context, config['dockerfilePath'])
            # Reject escaping links, including broken links, before Buildah sees the context.
            for root, dirs, files in os.walk(context, followlinks=False):
                for name in dirs + files:
                    path = Path(root) / name
                    if path.is_symlink() and not path.resolve().is_relative_to(context.resolve()):
                        raise ValueError('Symlink escapes the build context')
        else:
            dockerfile = context / 'Dockerfile'
            dockerfile.write_text(config['dockerfileContent'])
        if not dockerfile.is_file():
            raise ValueError('Dockerfile does not exist')
        certs = WORK / 'certs'
        certs.mkdir(exist_ok=True)
        if ca.exists() and ca.stat().st_size:
            (certs / 'ca.crt').write_bytes(ca.read_bytes())
        common = ['buildah', '--storage-driver=vfs']
        result['stage'] = 'build'
        args = common + ['bud', '--isolation=chroot', '--pull=always', '--tls-verify=true', '--cert-dir=' + str(certs), '-f', str(dockerfile), '-t', 'localhost/tessark-result']
        for key, value in config.get('buildArgs', {}).items():
            args += ['--build-arg', key + '=' + value]
        execute(args + [str(context)])
        result['stage'] = 'push'
        digest = WORK / 'digest'
        execute(common + ['push', '--tls-verify=true', '--cert-dir=' + str(certs), '--authfile=/config/auth.json', '--digestfile=' + str(digest), 'localhost/tessark-result', 'docker://' + config['destination']])
        result.update(status='succeeded', digest=digest.read_text().strip(), destination=config['destination'])
        return 0
    except Exception as error:
        # Subprocess errors include argv; keep them out of the persisted error summary.
        result['error'] = 'Command failed (exit %s)' % error.returncode if isinstance(error, subprocess.CalledProcessError) else str(error)[:500]
        print(result['stage'] + ': ' + result['error'], file=sys.stderr)
        return 1
    finally:
        Path('/dev/termination-log').write_text(json.dumps(result))


if __name__ == '__main__':
    if sys.argv[1:] == ['claim']:
        claim()
    else:
        sys.exit(build())
