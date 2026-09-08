/**
 * Permission model tests.
 *
 * These encode the least-privilege rules from the specification, and guard
 * against a subtle class of bug found during development: a *restriction*
 * (something that narrows access) accidentally being included in the "grant
 * everything" list, which silently limited a school owner to sections they
 * personally taught — none — leaving their student list empty.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERMISSIONS,
  RESTRICTIONS,
  ALL_PERMISSIONS,
  ALL_RESTRICTIONS,
  ROLE_TEMPLATES,
  isPermission,
  isRestriction,
  permissionLabel,
} from '../src/lib/auth/permissions.ts';

test('restrictions are never included in the grantable permission list', () => {
  // This is the exact bug that made the owner's student list read "0 students".
  for (const restriction of ALL_RESTRICTIONS) {
    assert.ok(
      !(ALL_PERMISSIONS as string[]).includes(restriction),
      `"${restriction}" is a restriction and must not appear in ALL_PERMISSIONS`,
    );
  }
});

test('full-access roles receive no restrictions', () => {
  for (const roleKey of ['owner', 'director']) {
    const role = ROLE_TEMPLATES[roleKey]!;
    for (const restriction of ALL_RESTRICTIONS) {
      assert.ok(
        !role.permissions.includes(restriction),
        `Role "${roleKey}" must not carry the restriction "${restriction}"`,
      );
    }
  }
});

test('an owner can see all students, a teacher only their own sections', () => {
  const owner = ROLE_TEMPLATES.owner!.permissions;
  assert.ok(owner.includes('student.view'));
  assert.ok(!owner.includes('restrict.ownSectionsOnly'));

  const teacher = ROLE_TEMPLATES.teacher!.permissions;
  assert.ok(teacher.includes('student.view'));
  assert.ok(
    teacher.includes('restrict.ownSectionsOnly'),
    'a teacher must be limited to their assigned sections',
  );
});

test('CRITICAL: a teacher has no financial permissions', () => {
  for (const roleKey of ['teacher', 'class_teacher']) {
    const permissions = ROLE_TEMPLATES[roleKey]!.permissions as string[];
    const financial = permissions.filter(
      (p) => p.startsWith('fee.') || p.startsWith('payment.') || p === 'finance.report',
    );
    assert.deepEqual(financial, [], `Role "${roleKey}" must not have finance access`);
  }
});

test('CRITICAL: finance staff cannot modify grades', () => {
  for (const roleKey of ['finance_officer', 'accountant']) {
    const permissions = ROLE_TEMPLATES[roleKey]!.permissions as string[];
    const gradeWrite = permissions.filter(
      (p) =>
        p === 'grade.enter' ||
        p === 'grade.submit' ||
        p === 'grade.review' ||
        p === 'grade.lock' ||
        p === 'grade.overrideLocked' ||
        p === 'grade.configure',
    );
    assert.deepEqual(gradeWrite, [], `Role "${roleKey}" must not be able to change grades`);
  }
});

test('CRITICAL: parents and students hold only their portal permission', () => {
  assert.deepEqual(ROLE_TEMPLATES.parent!.permissions, ['portal.parent']);
  assert.deepEqual(ROLE_TEMPLATES.student!.permissions, ['portal.student']);
});

test('CRITICAL: no non-management role can override a locked grade', () => {
  const allowed = new Set(['owner', 'director', 'principal']);
  for (const [key, role] of Object.entries(ROLE_TEMPLATES)) {
    if (allowed.has(key)) continue;
    assert.ok(
      !(role.permissions as string[]).includes('grade.overrideLocked'),
      `Role "${key}" must not be able to change locked marks`,
    );
  }
});

test('only the owner has billing access', () => {
  for (const [key, role] of Object.entries(ROLE_TEMPLATES)) {
    if (key === 'owner') continue;
    assert.ok(
      !(role.permissions as string[]).includes('school.billing'),
      `Role "${key}" must not have billing access`,
    );
  }
});

test('every permission referenced by a role template actually exists', () => {
  for (const [key, role] of Object.entries(ROLE_TEMPLATES)) {
    for (const permission of role.permissions) {
      assert.ok(
        isPermission(permission),
        `Role "${key}" references unknown permission "${permission}"`,
      );
    }
  }
});

test('permission and restriction keys do not collide', () => {
  for (const key of Object.keys(RESTRICTIONS)) {
    assert.ok(!(key in PERMISSIONS), `"${key}" is defined as both a permission and a restriction`);
  }
});

test('key helpers behave correctly', () => {
  assert.equal(isPermission('student.view'), true);
  assert.equal(isPermission('restrict.ownSectionsOnly'), true);
  assert.equal(isPermission('not.a.real.permission'), false);
  assert.equal(isRestriction('restrict.ownSectionsOnly'), true);
  assert.equal(isRestriction('student.view'), false);
  assert.equal(permissionLabel('student.view'), 'View student list and profiles');
  assert.equal(permissionLabel('unknown.key'), 'unknown.key');
});

test('every role template has a name and a description', () => {
  for (const [key, role] of Object.entries(ROLE_TEMPLATES)) {
    assert.ok(role.name.length > 0, `Role "${key}" needs a name`);
    assert.ok(role.nameAm.length > 0, `Role "${key}" needs an Amharic name`);
    assert.ok(role.description.length > 0, `Role "${key}" needs a description`);
    assert.match(role.nameAm, /[\u1200-\u137F]/, `Role "${key}" Amharic name must be in Ethiopic`);
  }
});
