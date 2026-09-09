"""Regression checks for the runner's context boundary (no cluster required)."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('runner', Path(__file__).resolve().parents[1] / 'deploy/build-runner/runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class ContextBoundary(unittest.TestCase):
    def test_paths_and_symlinks_cannot_escape_the_selected_context(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'context'
            root.mkdir()
            (root / 'Dockerfile').write_text('FROM scratch')
            (root / 'escape').symlink_to(Path(directory) / 'outside')
            self.assertEqual(runner.inside(root, 'Dockerfile'), root / 'Dockerfile')
            for path in ('../outside', '/etc/passwd', 'escape'):
                with self.assertRaises(ValueError):
                    runner.inside(root, path)

    def test_build_invocation_never_uses_a_shell(self):
        from unittest.mock import patch
        with patch.object(runner.subprocess, 'run') as run:
            runner.execute(['buildah', 'bud', '--build-arg', 'TEXT=$(id); echo hello', '/work/context'])
            args, kwargs = run.call_args
            self.assertIsInstance(args[0], list)
            self.assertEqual(args[0][3], 'TEXT=$(id); echo hello')
            self.assertNotIn('shell', kwargs)


if __name__ == '__main__':
    unittest.main()
