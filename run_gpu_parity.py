#!/usr/bin/env python3
"""Double-click me: the headless CPU/GPU parity run, logged to a timestamped file.

    Runs `node tests/gpu-parity.js 1000 --ensemble` - the plan's parity gate: three seeds, 1000
    frames each, CPU against GPU on the same world, compared against predeclared statistical
    bounds. It boots tests/gpu-parity.html in headless Chromium, so the rig has to be there:
    PGT_CHROME (the browser binary, default /tmp/chromium), PGT_PUPPETEER (a puppeteer-core
    install, default /tmp/rig/node_modules/puppeteer-core) and PGT_LIBS (the al2023 library
    directory, default /tmp/al2023/lib) - see findings-pitfalls-skills.md, "Headless WebGPU
    rig". With a hardware GPU the numbers are a measurement; under SwiftShader they are
    relative-only, so on a GPU-less machine read the run as a smoke, not a benchmark.

    The console output goes to experiments/logs/gpu-parity-<2026-09-15-01-34>.log. Its first
    line is the capture header: the page's environment (date to the minute, browser, OS/CPU
    type, GPU as a type plus one vendor word) and this side's (node, host type).

    Command line, optional - the arguments go straight to tests/gpu-parity.js:
        python3 run_gpu_parity.py 1000 --ensemble    (the default; phase H gate)
        python3 run_gpu_parity.py 200 --level=6
        python3 run_gpu_parity.py --batch            (Phase V: batched vs one-frame
                                                      encoders, zero tolerance)
        python3 run_gpu_parity.py 8 --determinism    (same-upload two-run bit identity)
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_common as rc

DEFAULTS = ['1000', '--ensemble']


def main():
    rc.setup()
    args = sys.argv[1:] or DEFAULTS
    missing = rig_missing()
    if missing:
        rc.fail('the headless GPU rig is incomplete: ' + ', '.join(missing) + '\n\n'
                'set PGT_CHROME (browser binary), PGT_PUPPETEER (puppeteer-core install) and\n'
                'PGT_LIBS (the al2023 libraries) - findings-pitfalls-skills.md, "Headless WebGPU\n'
                'rig" - or open tests/gpu-parity.html in a browser with WebGPU and read the page.')
    cmd = [rc.node(), rc.ROOT / 'tests' / 'gpu-parity.js'] + args
    log = rc.log_path('gpu-parity')
    header = 'gpu parity · ' + rc.stamp() + ' · ' + rc.host_line() + ' · ' + ' '.join(args)
    return rc.finish(log, rc.run(cmd, log, header))


def rig_missing():
    """The two paths tests/gpu-parity.js cannot start without, named when they are not there - a
    driver that dies inside require() says nothing about which one is missing. PGT_LIBS (the
    al2023 libraries the sandbox chromium needs) is optional and left to the driver."""
    needed = {'PGT_CHROME': '/tmp/chromium',
              'PGT_PUPPETEER': '/tmp/rig/node_modules/puppeteer-core'}
    return [name + '=' + os.environ.get(name, dflt) for name, dflt in needed.items()
            if not Path(os.environ.get(name, dflt)).exists()]


if __name__ == '__main__':
    sys.exit(main())
