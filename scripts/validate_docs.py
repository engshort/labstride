#!/usr/bin/env python3
"""Validate documentation, not the planned application or live integrations."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

try:
    from jsonschema import Draft202012Validator
except ImportError:
    raise SystemExit('Install the documentation dependency: python3 -m pip install -r requirements-docs.txt')

from render_docs import ROOT, checklist
from schema_validation import validators_for


def repository_files():
    for directory, dirs, files in os.walk(ROOT):
        dirs[:] = sorted(d for d in dirs if d not in ('.git', 'node_modules', '.venv', '__pycache__', '.labstride-local'))
        for name in sorted(files):
            path = Path(directory) / name
            require(path.resolve().is_relative_to(ROOT), f'File escapes repository: {path}')
            yield path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(path):
    return json.loads((ROOT / path).read_text(encoding='utf-8'))


def unique(rows, label):
    ids = [row['id'] for row in rows]
    require(len(ids) == len(set(ids)), f'Duplicate {label} ID')
    return set(ids)


def main():
    # Parse every JSON file, including files not otherwise referenced below.
    files = list(repository_files())
    for path in (p for p in files if p.suffix == '.json'):
        json.loads(path.read_text(encoding='utf-8'))
    links = 0
    for path in (p for p in files if p.suffix == '.md'):
        for target in re.findall(r'\[[^\]]+\]\(([^)\s]+)\)', path.read_text(encoding='utf-8')):
            parsed = urlsplit(target)
            if parsed.scheme or target.startswith(('#', '//')):
                continue
            destination = (path.parent / unquote(parsed.path)).resolve()
            require(destination.is_relative_to(ROOT), f'Link escapes repository: {path}: {target}')
            require(destination.exists(), f'Missing linked file: {path}: {target}')
            links += 1

    pairs = {
        **{name:name for name in ['cleanup-delete-input','cleanup-preparation','cleanup-tombstone','ssh-cleanup-delete-request','ssh-cleanup-delete-response','cleanup-policy','cleanup-inspection','cleanup-decision','cleanup-action-input','ssh-cleanup-request','ssh-cleanup-response','managed-cleanup-observation']},
        **{name: name for name in ['operational-event','operational-metrics','retention-result']},
        'backup-bundle': 'backup-bundle', 'maintenance-operation': 'maintenance-operation', 'maintenance-result': 'maintenance-result',
        'config': 'installation.template', 'extension': 'extension', 'cli-version': 'cli-version',
        'operational-installation': 'operational-installation', 'self-build-input': 'self-build-input', 'managed-result': 'managed-result', 'managed-session-start': 'managed-session-start',
        'operation': 'operation', 'receipt': 'receipt', 'event': 'event',
        'session-request': 'session-request', 'session-observation': 'session-observation',
        'contract-request': 'contract-request', 'contract-result': 'contract-result',
        'hook-observation': 'hook-observation', 'hook-ack': 'hook-ack',
        'extension-artifact': 'extension-artifact', 'extension-lock': 'extension-lock',
        'extension-profile': 'extension-profile', 'session-binding': 'session-binding',
        'session-command': 'session-command',
        'session-handoff': 'session-handoff', 'session-reply': 'session-reply',
        'codex-question': 'codex-question', 'codex-answer': 'codex-answer', 'session-probe': 'session-probe',
        'configuration-snapshot': 'configuration-snapshot', 'provider-binding': 'provider-binding',
        'rule-observation': 'rule-observation', 'rule-evaluation': 'rule-evaluation',
        'authorization-policy': 'authorization-policy', 'policy-change': 'policy-change',
        'actor-evidence': 'actor-evidence', 'authorization-decision': 'authorization-decision',
        'ssh-enrollment': 'ssh-enrollment', 'ssh-helper-policy': 'ssh-helper-policy',
        'ssh-helper-request': 'ssh-helper-request', 'ssh-helper-response': 'ssh-helper-response',
        'ssh-reservation': 'ssh-reservation',
        'ssh-workspace-policy': 'ssh-workspace-policy',
        'ssh-workspace-request': 'ssh-workspace-request',
        'ssh-workspace-response': 'ssh-workspace-response',
        'ssh-workspace-receipt': 'ssh-workspace-receipt',
        'workspace-probe': 'workspace-probe',
        'workspace-continuity-probe': 'workspace-continuity-probe',
        'workspace-continuity-session': 'workspace-continuity-session',
        'github-issue-field-profile': 'github-issue-field-profile',
        'runtime-recipe': 'runtime-recipe',
        'runtime-create-input': 'runtime-create-input',
        'runtime-driver-request': 'runtime-driver-request',
        'runtime-driver-reply': 'runtime-driver-reply',
        'runtime-receipt': 'runtime-receipt',
        'ssh-runtime-policy': 'ssh-runtime-policy',
        'ssh-runtime-installation': 'ssh-runtime-installation',
        'ssh-runtime-request': 'ssh-runtime-request',
        'ssh-runtime-response': 'ssh-runtime-response',
        'deployment-profile': 'deployment-profile',
        'target-observation-request': 'target-observation-request',
        'target-observation': 'target-observation',
        'deployment-evidence': 'deployment-evidence',
        'deployment-order': 'deployment-order',
        'revision-comparison': 'revision-comparison',
        'deployment-order-check': 'deployment-order-check',
        'deployment-successor-evidence': 'deployment-successor-evidence',
        'workflow-enrollment': 'workflow-deployment-enrollment',
    }
    validators, examples = validators_for(ROOT / 'schemas'), {}
    for name, example in pairs.items():
        shape = read(f'schemas/{name}.schema.json')
        Draft202012Validator.check_schema(shape)
        validator = validators[name]
        value = read(f'examples/{example}.json')
        validator.validate(value)
        validators[name], examples[name] = validator, value
        malformed = copy.deepcopy(value)
        malformed['unexpectedCoreKey'] = True
        require(not validator.is_valid(malformed), f'{name} accepts unknown core keys')
        if name not in ('runtime-recipe', 'runtime-create-input'):
            malformed = copy.deepcopy(value)
            del malformed['schemaVersion']
            require(not validator.is_valid(malformed), f'{name} accepts missing version')

    malformed = copy.deepcopy(examples['operation'])
    malformed['source']['sha'] = 'main'
    require(not validators['operation'].is_valid(malformed), 'Operation accepts branch instead of exact SHA')
    malformed = copy.deepcopy(examples['receipt'])
    malformed['conclusion'] = 'failed'
    require(not validators['receipt'].is_valid(malformed), 'Failed receipt accepts missing error')
    malformed = copy.deepcopy(examples['session-request'])
    malformed['command'] = 'resume'
    require(not validators['session-request'].is_valid(malformed), 'Resume accepts missing session')

    for name, field in [('operation', 'deadline'), ('receipt', 'observedAt'),
                        ('event', 'occurredAt'), ('event', 'observedAt'),
                        ('hook-observation', 'occurredAt')]:
        malformed = copy.deepcopy(examples[name])
        malformed[field] = 'not-a-date'
        require(not validators[name].is_valid(malformed), f'{name} accepts invalid {field}')
    malformed = copy.deepcopy(examples['config'])
    malformed['broker']['url'] = 'not a uri'
    require(not validators['config'].is_valid(malformed), 'Config accepts invalid broker URI')
    families = read('examples/contract-families.json')
    for request, result in zip(families['requests'], families['results'], strict=True):
        validators['contract-request'].validate(request)
        validators['contract-result'].validate(result)
        for key in ('requestId', 'extensionId', 'protocol', 'family', 'method'):
            require(request[key] == result[key], f'Contract fixture correlation mismatch: {key}')

    operation = copy.deepcopy(examples['operation'])
    digest = operation.pop('requestDigest')
    # Fixtures use ASCII keys/strings and integers only. This is not a general RFC 8785 implementation.
    canonical = json.dumps(operation, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    require(hashlib.sha256(canonical.encode()).hexdigest() == digest, 'Operation fixture digest mismatch')
    receipt = examples['receipt']
    for left, right in [('operationId', 'operationId'), ('targetId', 'targetId')]:
        require(receipt[left] == operation[right], f'Receipt fixture mismatch: {left}')
    require(receipt['sourceSha'] == operation['source']['sha'] and receipt['requestDigest'] == digest,
            'Receipt fixture source/digest mismatch')

    packages = read('docs/work-packages.json')
    package_ids = unique(packages, 'work package')
    graph = {p['id']: p['depends_on'] for p in packages}
    visited, visiting = set(), set()

    def visit(node):
        require(node in package_ids, f'Unknown package dependency {node}')
        require(node not in visiting, f'Work-package dependency cycle at {node}')
        if node in visited:
            return
        visiting.add(node)
        for dependency in graph[node]:
            visit(dependency)
        visiting.remove(node)
        visited.add(node)

    for node in graph:
        visit(node)
    requirements = read('docs/backlog.json')['requirements']
    requirement_ids = unique(requirements, 'requirement')
    cases = read('docs/acceptance-cases.json')['cases']
    unique(cases, 'acceptance case')
    covered = set()
    for case in cases:
        require(set(case['requirements']) <= requirement_ids, f'Unknown requirement in {case["id"]}')
        require(case['status'] in ('not_run', 'passed', 'failed', 'blocked'), f'Invalid case status: {case["id"]}')
        if case['status'] == 'passed':
            require(case['evidence'], f'Passed case lacks evidence: {case["id"]}')
        covered.update(case['requirements'])
    require(covered == requirement_ids, f'Requirements missing acceptance cases: {sorted(requirement_ids - covered)}')
    for r in requirements:
        require(r['work_package'] in package_ids, f'Unknown work package in {r["id"]}')
        require(r['depends_on_work_packages'] == graph[r['work_package']], f'Dependency drift in {r["id"]}')
        require((ROOT / 'docs' / r['spec']).is_file(), f'Missing specification for {r["id"]}')
        require(r['acceptance_criteria'], f'Missing acceptance criteria for {r["id"]}')
        require(r['status'] in ('planned', 'in_progress', 'implemented', 'verified'), f'Invalid requirement status {r["id"]}')
        if r['status'] == 'verified':
            require(r['verification_evidence'], f'Verified requirement lacks evidence: {r["id"]}')
    require((ROOT / 'docs/04-feature-checklist.md').read_text() == checklist(requirements),
            'Stale checklist: run python3 scripts/render_docs.py')
    print(f'PASS: {links} local file links; {len(pairs)} schema/example pairs and rejection cases; '
          f'{len(requirements)} requirements; {len(packages)} acyclic work packages; {len(cases)} acceptance specifications.')
    print('Application acceptance cases have not been executed by this documentation check.')


if __name__ == '__main__':
    main()
