"""Guard native workflow/composite boundaries, independently of the flattened safety view."""

import re
import tempfile
import unittest
from pathlib import Path

from workflow_sources import ROOT, expand_actions, jobs, steps


class CompositeActions(unittest.TestCase):
    def test_worker_calls_expand_one_release_job_not_all_apps(self):
        release = jobs((ROOT / '.github/workflows/worker-release.yml').read_text())
        self.assertEqual(set(release), {'release'})
        job = release['release']
        self.assertIn("if: github.ref == 'refs/heads/main'", job)
        self.assertIn('group: ${{ inputs.app }}-production', job)
        self.assertIn('cancel-in-progress: false', job)
        self.assertIn("timeout-minutes: ${{ inputs.app == 'website-relay' && 10 || 15 }}", job)
        self.assertIn('environment:\n      name: production', job)
        sequence = steps(job.split('    steps:\n', 1)[1])
        preflight = next(i for i, step in enumerate(sequence) if 'id: preflight\n' in step)
        record = next(i for i, step in enumerate(sequence) if 'control.py record ' in step)
        calls = [step for step in sequence if 'uses: ./.github/actions/release-' in step]
        apps = {path.parent.name.removeprefix('release-') for path in (ROOT / '.github/actions').glob('release-*/action.yml')}
        self.assertEqual(len(calls), len(apps))
        for app in apps:
            call = next(step for step in calls if f'uses: ./.github/actions/release-{app}\n' in step)
            self.assertIn(f"if: inputs.app == '{app}' && steps.preflight.outputs.required == 'true'", call)
            self.assertIn('required: ${{ steps.preflight.outputs.required }}', call)
            self.assertLess(preflight, sequence.index(call))
            self.assertLess(sequence.index(call), record)
        self.assertNotIn('secrets.', job.split('    steps:\n', 1)[0])
        self.assertNotIn('continue-on-error:', job)
        self.assertNotIn('always()', sequence[record])

    def test_local_actions_have_explicit_context_shell_and_directory(self):
        for path in (ROOT / '.github/actions').glob('*/action.yml'):
            with self.subTest(action=path.parent.name):
                text = path.read_text()
                self.assertIn('  using: composite\n', text)
                expressions = ' '.join(re.findall(r'\$\{\{(.*?)\}\}', text, re.S))
                self.assertNotRegex(expressions, r'\b(secrets|needs|matrix|strategy)\.')
                declared = set(re.findall(r'^  ([a-z0-9-]+):$', text.split('runs:\n', 1)[0], re.M))
                referenced = set(re.findall(r'\binputs\.([a-z0-9-]+)', text))
                self.assertLessEqual(referenced, declared)
                body = '\n'.join('  ' + line for line in text.split('  steps:\n', 1)[1].splitlines())
                for step in steps(body):
                    if re.search(r'^        run:', step, re.M):
                        # Matches Ubuntu's previous unspecified-shell behavior. Do not add pipefail in a refactor.
                        self.assertIn('        shell: bash -e {0}\n', step)
                        self.assertRegex(step, r'(?m)^        working-directory: .+$')
                    if 'uses:' in step:
                        self.assertRegex(step, r'uses: [\w./-]+@[0-9a-f]{40}\b')
                self.assertNotIn('persist-credentials: true', text)

    def test_every_call_supplies_exact_declared_inputs(self):
        for filename in ('ci.yml', 'worker-release.yml'):
            for job in jobs((ROOT / '.github/workflows' / filename).read_text()).values():
                if '    steps:\n' not in job:
                    continue
                for step in steps(job.split('    steps:\n', 1)[1]):
                    match = re.search(r'uses: (\./\.github/actions/[a-z-]+)', step)
                    if not match:
                        continue
                    text = (ROOT / match.group(1) / 'action.yml').read_text()
                    header = text.split('runs:\n', 1)[0]
                    declared = set()
                    if 'inputs:\n' in header:
                        inputs = header.split('inputs:\n', 1)[1].split('outputs:\n', 1)[0]
                        declared = set(re.findall(r'^  ([a-z0-9-]+):$', inputs, re.M))
                    passed = set(re.findall(r'^          ([a-z0-9-]+):', step, re.M))
                    self.assertEqual(passed, declared, match.group(1))

    def test_runtime_shards_and_resume_are_passed_explicitly(self):
        ci = jobs((ROOT / '.github/workflows/ci.yml').read_text())
        self.assertIn('shard-index: ${{ strategy.job-index }}', ci['todofy-runtime'])
        self.assertIn('shard-total: ${{ strategy.job-total }}', ci['todofy-runtime'])
        self.assertIn("build-image: ${{ !(github.event_name == 'workflow_dispatch' && inputs.resume_vps_release) }}", ci['platform-checks'])
        action = (ROOT / '.github/actions/check-platform/action.yml').read_text()
        self.assertEqual(action.count('if: ${{ fromJSON(inputs.build-image) }}'), 2)
        for job in ('newsletter-deploy', 'platform-image'):
            self.assertIn('image: ${{ steps.publish.outputs.image }}', ci[job])
            self.assertIn('id: publish', ci[job])
            self.assertIn('artifact-run-id: ${{ needs.changes.outputs.reused_run_id || github.run_id }}', ci[job])

    def test_reader_follows_real_action_commands_and_refuses_missing_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            action = root / '.github/actions/example/action.yml'
            action.parent.mkdir(parents=True)
            action.write_text('runs:\n  using: composite\n  steps:\n    - run: echo ${{ inputs.value }}\n')
            call = '    steps:\n      - name: Example\n        uses: ./.github/actions/example\n        with:\n          value: hello\n'
            self.assertIn('run: echo hello', expand_actions(call, root))
            action.write_text(action.read_text().replace('echo', 'printf'))
            self.assertIn('run: printf hello', expand_actions(call, root))
            with self.assertRaisesRegex(ValueError, 'Unresolved action input'):
                expand_actions(call.replace('          value: hello\n', ''), root)


if __name__ == '__main__':
    unittest.main()
