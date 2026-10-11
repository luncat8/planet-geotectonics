"""Sediment bake preflight: python3 -m unittest discover -s tests -p 'test_*.py'."""
import importlib.util
import pathlib
import struct
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'tools' / 'earth' / 'bake_earth.py'
spec = importlib.util.spec_from_file_location('bake_earth', SCRIPT)
bake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bake)


class SedimentPreflightTests(unittest.TestCase):
	def test_target_contract(self):
		for name, epoch in [('earth', 250), ('pangaea', 0), ('pangaea', 250)]:
			args = SimpleNamespace(name=name, sediment='extract.bin')
			with self.subTest(name=name, epoch=epoch):
				with self.assertRaisesRegex(SystemExit, 'refused'):
					bake.validate_sediment_target(args, epoch)
				args.sediment = None
				bake.validate_sediment_target(args, epoch)
		bake.validate_sediment_target(SimpleNamespace(name='earth', sediment='extract.bin'), 0)

	def test_refusal_preserves_outputs(self):
		# Actual CLI paths, with a tiny paleo fixture so a regression cannot start a long bake.
		with tempfile.TemporaryDirectory(prefix='pgt-bake-') as tmp:
			tmp = pathlib.Path(tmp)
			raster = tmp / 'paleo.bin'
			output = tmp / 'pack.js'
			report = tmp / 'report.txt'
			for epoch, name, paleo in [(250, 'earth', True), (0, 'other', True), (0, 'other', False)]:
				for existing in [False, True]:
					with self.subTest(epoch=epoch, name=name, paleo=paleo, existing=existing):
						raster.write_bytes(struct.pack('<HHHhBB', 1, 1, epoch, 200, 255, 1))
						for dest in [output, report]:
							dest.unlink(missing_ok=True)
							if existing:
								dest.write_text('keep this output', encoding='utf-8')
						cmd = [sys.executable, str(SCRIPT), '--name', name, '--deg', '180',
							'--out', str(output), '--report', str(report), '--sediment',
							str(ROOT / 'data/earth/sediment-crust1.bin')]
						if paleo:
							cmd += ['--paleo', str(raster)]
						result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=30)
						self.assertNotEqual(result.returncode, 0)
						self.assertIn('refused', result.stderr)
						for dest in [output, report]:
							if existing:
								self.assertEqual(dest.read_text(encoding='utf-8'), 'keep this output')
							else:
								self.assertFalse(dest.exists())

	def test_modern_postpass_and_default_off(self):
		args = SimpleNamespace(name='earth', sediment=None, out='pack.js')
		with patch.object(bake.subprocess, 'run') as run:
			bake.apply_sediment_pass(args, 0)
			run.assert_not_called()
			args.sediment = 'extract.bin'
			run.return_value.returncode = 0
			bake.apply_sediment_pass(args, 0)
			self.assertEqual(run.call_args.args[0][-5:],
				['--apply', '--pack', 'pack.js', '--sediment', 'extract.bin'])
			run.return_value.returncode = 1
			with self.assertRaisesRegex(SystemExit, 'sediment apply exited 1'):
				bake.apply_sediment_pass(args, 0)

	def test_manifest_mismatch_refused(self):
		with tempfile.TemporaryDirectory(prefix='pgt-manifest-') as tmp:
			root = pathlib.Path(tmp)
			data = root / 'input.bin'
			data.write_bytes(b'changed')
			manifest = {'files': {'input.bin': '0' * 32}}
			with patch.object(bake, 'repo_root', return_value=str(root)):
				with self.assertRaisesRegex(SystemExit, 'MD5 .* != manifest'):
					bake.verify_listed_input(str(data), manifest)
				bake.verify_listed_input(str(data), {'files': {}})


if __name__ == '__main__':
	unittest.main()
