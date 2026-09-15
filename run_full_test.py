#!/usr/bin/env python3
"""Double-click me: the full node test suite, logged to a timestamped file.

    Runs `node tests/run-all.js --full` - the regression gate, which is the short profile plus
    the four histories (kinematics, ores, alloc, longrun). The short profile is what an agent
    iterates on in a sandbox; the histories take ~15 min there and ~18 min on the owner's rig,
    and anything reaching a GPU in a sandbox runs on SwiftShader, so full belongs on a real
    machine - which is what this double-click is for.

    The console output goes to experiments/logs/full-test-<2026-09-15-01-34>.log, whose first
    line is the one short environment header every capture carries (minute resolution, node
    version, OS/CPU type). The log is opened when the run finishes.

    Command line, optional:
        python3 run_full_test.py --release   the 4.5 Gyr acceptance profile (implies --full)
        python3 run_full_test.py --short     the iterating profile, for a quick check
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_common as rc


def main():
    rc.setup()
    args = sys.argv[1:]
    profile = 'short' if '--short' in args else 'full'
    cmd = [rc.node(), rc.ROOT / 'tests' / 'run-all.js']
    if profile == 'full':
        cmd.append('--full')
    if '--release' in args:
        cmd.append('--release')
    log = rc.log_path('full-test' if profile == 'full' else 'short-test')
    header = profile + ' test · ' + rc.stamp() + ' · ' + rc.host_line()
    return rc.finish(log, rc.run(cmd, log, header))


if __name__ == '__main__':
    sys.exit(main())
