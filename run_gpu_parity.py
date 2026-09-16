#!/usr/bin/env python3
"""Double-click me: the headless CPU/GPU parity run, logged to a timestamped file.

    Runs `node tests/gpu-parity.js 1000 --ensemble` - the plan's parity gate: three seeds, 1000
    frames each, CPU against GPU on the same world, compared against predeclared statistical
    bounds. It boots tests/gpu-parity.html in headless Chromium, so a browser + puppeteer
    have to be reachable. Resolution order (also in tests/headless-common.js):

      puppeteer:  PGT_PUPPETEER env  →  ./node_modules/puppeteer(-core)  →  bare
                  `puppeteer-core` / `puppeteer` on NODE_PATH / global  →  /tmp/rig
      chrome:     PGT_CHROME / PUPPETEER_EXECUTABLE_PATH / CHROME_PATH  →  puppeteer
                  executablePath()  →  @sparticuz/chromium  →  which google-chrome/
                  chromium  →  /tmp/chromium  →  ~/.cache/puppeteer/chrome/…

    PGT_LIBS (the al2023 library directory, default /tmp/al2023/lib) is optional.

    If nothing is found and `npm` is on PATH, `python3 run_gpu_parity.py --install`
    (or just running without args when npm is present) will try
      npm install --prefix /tmp/rig puppeteer-core
      npx --yes puppeteer browsers install chrome
    so the rig heals itself. With a hardware GPU the numbers are a measurement;
    under SwiftShader they are relative-only, so on a GPU-less machine read the
    run as a smoke, not a benchmark.

    The console output goes to experiments/logs/gpu-parity-<2026-09-15-01-34>.log. Its first
    line is the capture header: the page's environment (date to the minute, browser, OS/CPU
    type, GPU as a type plus one vendor word) and this side's (node, host type).

    No puppeteer at all? Same browser as in-gui — like webgpu-smoke.html:
      open tests/gpu-parity.html directly in Chrome 113+ (file:// works), click
      “Run ensemble” and “Copy log”. Identical harness, no headless rig needed.
      Same for bench.html and experiments/heavy-overlap.html.

    Command line, optional - the arguments go straight to tests/gpu-parity.js:
        python3 run_gpu_parity.py 1000 --ensemble    (the default; phase H gate)
        python3 run_gpu_parity.py 200 --level=6
        python3 run_gpu_parity.py --batch            (Phase V: batched vs one-frame
                                                      encoders, zero tolerance)
        python3 run_gpu_parity.py 8 --determinism    (same-upload two-run bit identity)
        python3 run_gpu_parity.py --install          (install puppeteer+chrome to /tmp/rig
                                                      and then run)
        python3 run_gpu_parity.py --check            (probe and print what was found)
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_common as rc

DEFAULTS = ['1000', '--ensemble']


def main():
    rc.setup()
    args = sys.argv[1:] or DEFAULTS
    if '--help' in args or '-h' in args:
        print(__doc__)
        return 0
    # --check probes without running
    if '--check' in args:
        return check_rig()
    # --install: ensure rig, then run (or just ensure if no other args)
    wants_install = '--install' in args
    if wants_install:
        args = [a for a in args if a != '--install']
        if not args:
            args = DEFAULTS
        ok, msg = ensure_rig(install=True)
        print(msg)
        if not ok:
            return 1
    else:
        # auto-heal if npm is present and puppeteer is missing (user asked: install using available tools)
        ok, msg = ensure_rig(install=False)
        if not ok:
            # try one auto-install attempt when npm is on PATH, otherwise report
            if shutil.which('npm') and shutil.which('node'):
                print(msg)
                print('\n-- trying auto-install via npm (override with --install to force, or set PGT_ vars) --\n')
                ok2, msg2 = ensure_rig(install=True)
                print(msg2)
                if not ok2:
                    rc.fail(msg2 + '\n\nOr open tests/gpu-parity.html directly in Chrome 113+ (file://) and click Run ensemble — no headless rig needed (see header).')
                    return 1
                ok = ok2
            else:
                rc.fail(msg + '\n\nOr open tests/gpu-parity.html directly in Chrome 113+ (file://) and click Run ensemble — no headless rig needed (see header).')
                return 1
    cmd = [rc.node(), rc.ROOT / 'tests' / 'gpu-parity.js'] + args
    log = rc.log_path('gpu-parity')
    header = 'gpu parity · ' + rc.stamp() + ' · ' + rc.host_line() + ' · ' + ' '.join(args)
    return rc.finish(log, rc.run(cmd, log, header))


def check_rig():
    ok, msg = ensure_rig(install=False)
    print(msg)
    return 0 if ok else 1


def ensure_rig(install=False):
    """Probe puppeteer + chrome via node helper; optionally npm-install.

    Returns (ok, message). ok means tests/gpu-parity.js should be able to launch.
    """
    node = rc.node()
    # 1. probe via the shared helper (if present)
    probe_js = (
        "const hc=require('./tests/headless-common.js');"
        " const p=hc.resolvePuppeteer(); const c=p?hc.resolveChrome(p):null;"
        " console.log(JSON.stringify({puppeteer: p? (p.__resolvedFrom||'ok') : null, chrome: c||null}));"
    )
    try:
        r = subprocess.run([node, '-e', probe_js], cwd=str(rc.ROOT), capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            import json
            info = json.loads(r.stdout.strip().splitlines()[-1])
            pup = info.get('puppeteer')
            chrome = info.get('chrome')
            if pup and chrome:
                return True, f'rig ok: puppeteer={pup}  chrome={chrome}'
            if pup and not chrome:
                if install:
                    return try_install_chrome(pup, chrome)
                return False, f'rig incomplete: puppeteer={pup} but no chrome binary found\n' + install_hint()
            # no puppeteer
            if install:
                return try_install_puppeteer()
            return False, f'rig incomplete: no puppeteer found (chrome={chrome or "none"})\n' + install_hint()
    except Exception as e:
        # helper missing or node error — fall back to simpler checks
        pass

    # Fallback simple checks (older tree without helper)
    pup_candidates = [
        os.environ.get('PGT_PUPPETEER'),
        str(rc.ROOT / 'node_modules' / 'puppeteer-core'),
        str(rc.ROOT / 'node_modules' / 'puppeteer'),
        '/tmp/rig/node_modules/puppeteer-core',
        '/tmp/rig/node_modules/puppeteer',
    ]
    # also try bare requires via node
    for cand in ['puppeteer-core', 'puppeteer']:
        try:
            subprocess.run([node, '-e', f"require('{cand}')"], capture_output=True, check=True, timeout=5)
            pup_candidates.append(cand)
            break
        except Exception:
            pass
    pup_found = None
    for c in pup_candidates:
        if not c:
            continue
        if c in ('puppeteer-core', 'puppeteer'):
            pup_found = c
            break
        if Path(c).exists():
            pup_found = c
            break
    if not pup_found:
        if install:
            return try_install_puppeteer()
        return False, 'rig incomplete: PGT_PUPPETEER / puppeteer-core / puppeteer not found\n' + install_hint()

    chrome_found = None
    for env in ['PGT_CHROME', 'PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH']:
        p = os.environ.get(env)
        if p and Path(p).exists():
            chrome_found = p
            break
    if not chrome_found:
        for bin in ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium', 'chrome']:
            p = shutil.which(bin)
            if p:
                chrome_found = p
                break
    if not chrome_found:
        for p in ['/tmp/chromium', '/tmp/chrome']:
            if Path(p).exists():
                chrome_found = p
                break
    if not chrome_found and pup_found:
        # try puppeteer executablePath
        try:
            js = f"console.log(require('{pup_found}').executablePath())"
            r = subprocess.run([node, '-e', js], capture_output=True, text=True, timeout=5)
            cand = r.stdout.strip().splitlines()[-1] if r.stdout else ''
            if cand and Path(cand).exists():
                chrome_found = cand
        except Exception:
            pass
    if pup_found and chrome_found:
        return True, f'rig ok: puppeteer={pup_found}  chrome={chrome_found}'
    if pup_found and not chrome_found:
        if install:
            return try_install_chrome(pup_found, None)
        return False, f'rig incomplete: puppeteer={pup_found} but no chrome binary\n' + install_hint()
    return False, 'rig incomplete: puppeteer not found\n' + install_hint()


def try_install_puppeteer():
    if not shutil.which('npm'):
        return False, 'npm not on PATH — cannot auto-install. ' + install_hint()
    print('installing puppeteer-core to /tmp/rig (npm install --prefix /tmp/rig puppeteer-core)…')
    try:
        subprocess.run(['npm', 'install', '--prefix', '/tmp/rig', 'puppeteer-core'], check=True)
    except subprocess.CalledProcessError as e:
        return False, f'npm install puppeteer-core failed: {e}\n' + install_hint()
    # also try to get chrome
    return try_install_chrome('/tmp/rig/node_modules/puppeteer-core', None)


def try_install_chrome(pup_from, chrome_path):
    # if we have a puppeteer that can download browsers, do so
    if shutil.which('npx'):
        print('installing chrome via `npx puppeteer browsers install chrome` …')
        try:
            # prefer the puppeteer that was found, else the /tmp/rig one
            subprocess.run(['npx', '--yes', 'puppeteer', 'browsers', 'install', 'chrome'], check=False, timeout=180)
        except Exception as e:
            print(f'npx puppeteer browsers install failed: {e}')
    # re-probe
    node = rc.node()
    probe_js = (
        "const hc=require('./tests/headless-common.js');"
        " const p=hc.resolvePuppeteer(); const c=p?hc.resolveChrome(p):null;"
        " console.log(JSON.stringify({puppeteer: p? (p.__resolvedFrom||'ok') : null, chrome: c||null}));"
    )
    try:
        r = subprocess.run([node, '-e', probe_js], cwd=str(rc.ROOT), capture_output=True, text=True, timeout=10)
        import json
        info = json.loads(r.stdout.strip().splitlines()[-1])
        pup = info.get('puppeteer')
        chrome = info.get('chrome')
        if pup and chrome:
            return True, f'rig ok after install: puppeteer={pup}  chrome={chrome}'
        return False, f'still incomplete after install: puppeteer={pup} chrome={chrome}\n' + install_hint()
    except Exception as e:
        return False, f'install probe failed: {e}\n' + install_hint()


def install_hint():
    return (
        'set PGT_CHROME (browser binary), PGT_PUPPETEER (puppeteer-core install) and\n'
        'PGT_LIBS (the al2023 libraries) — findings-pitfalls-skills.md, “Headless WebGPU\n'
        'rig” — or:\n'
        '  npm install puppeteer            # system install, auto-found\n'
        '  npm install --prefix /tmp/rig puppeteer-core && npx puppeteer browsers install chrome\n'
        '  PGT_PUPPETEER=/path/to/puppeteer-core PGT_CHROME=/path/to/chrome python3 run_gpu_parity.py\n'
        'or open tests/gpu-parity.html in Chrome 113+ (file://) and click Run ensemble.'
    )


if __name__ == '__main__':
    sys.exit(main())
