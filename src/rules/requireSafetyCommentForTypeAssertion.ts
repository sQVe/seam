import type { ESTree, Rule, SourceCode } from '@oxlint/plugins';

import { hasDisableReason, lineDisableScope } from '../shared/comments.ts';

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

interface DisabledLines {
  sameLine: Set<number>;
  nextLine: Set<number>;
}

interface CommentAnchors {
  // The assertion and its ancestors below the statement that owns it.
  inner: ESTree.Node[];
  // The owning statement, then the loop or export around it.
  statements: ESTree.Node[];
}

// `SAFETY:` followed by text, not preceded by a letter, digit, or underscore.
const safetyPattern = /(?:^|[^\p{L}\p{N}_])SAFETY\s*:\s*\S/u;

// Comments above these statements explain the assertions inside them.
const commentOwnerKinds = new Set([
  'ExpressionStatement',
  'PropertyDefinition',
  'ReturnStatement',
  'ThrowStatement',
  'VariableDeclaration',
]);

const isConstAssertion = (node: TypeAssertion): boolean => {
  const annotation = node.typeAnnotation;

  return (
    annotation.type === 'TSTypeReference' &&
    annotation.typeName.type === 'Identifier' &&
    annotation.typeName.name === 'const'
  );
};

const hasSafetyCommentBefore = (
  sourceCode: SourceCode,
  owner: ESTree.Node,
  assertion: TypeAssertion,
): boolean =>
  sourceCode
    .getCommentsBefore(owner)
    .some((comment) => comment.end <= assertion.start && safetyPattern.test(comment.value));

// The loop whose head declares `node`; the comment above that loop covers the declaration.
const loopHeadOf = (node: ESTree.Node): ESTree.Node | undefined => {
  const { parent } = node;

  if (parent?.type === 'ForStatement') {
    return parent.init === node ? parent : undefined;
  }

  const isForInOrOf = parent?.type === 'ForInStatement' || parent?.type === 'ForOfStatement';

  return isForInOrOf && parent.left === node ? parent : undefined;
};

const exportOf = (owner: ESTree.Node): ESTree.Node | undefined => {
  const parent = owner.parent;
  const exportsOwner = parent?.type === 'ExportNamedDeclaration' && parent.declaration === owner;

  return exportsOwner ? parent : undefined;
};

// A comment before any anchor explains the assertion.
const commentAnchorsOf = (assertion: TypeAssertion): CommentAnchors => {
  const inner: ESTree.Node[] = [];
  let current: ESTree.Node = assertion;

  while (!commentOwnerKinds.has(current.type)) {
    inner.push(current);

    if (current.parent.type === 'Program') {
      return { inner, statements: [] };
    }

    current = current.parent;
  }

  const statements: ESTree.Node[] = [current];
  const outer = loopHeadOf(current) ?? exportOf(current);

  if (outer !== undefined) {
    statements.push(outer);
  }

  return { inner, statements };
};

// Lines where a one-line directive with a reason turns off the rule this comment replaces.
const disabledLinesOf = (sourceCode: SourceCode): DisabledLines => {
  const disabled: DisabledLines = { sameLine: new Set(), nextLine: new Set() };

  for (const comment of sourceCode.getAllComments()) {
    const scope = lineDisableScope(comment, 'typescript/no-unsafe-type-assertion');

    if (scope === undefined || !hasDisableReason(comment)) {
      continue;
    }

    if (scope === 'line') {
      disabled.sameLine.add(comment.loc.start.line);
    } else {
      disabled.nextLine.add(comment.loc.end.line + 1);
    }
  }

  return disabled;
};

const isDisabledWithReason = (
  disabled: DisabledLines,
  statements: ESTree.Node[],
  assertion: TypeAssertion,
): boolean => {
  const coveredNodes = [assertion, ...statements];

  return (
    disabled.sameLine.has(assertion.loc.start.line) ||
    coveredNodes.some((node) => disabled.nextLine.has(node.loc.start.line))
  );
};

export const requireSafetyCommentForTypeAssertionRule: Rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      missingSafetyComment:
        'This type assertion has no `SAFETY:` comment. State the checked invariant right before the assertion or its statement, or give a reason after " -- " in a disable comment for `typescript/no-unsafe-type-assertion`.',
    },
  },
  create(context) {
    let disabledLines: DisabledLines | undefined;

    const isJustified = (node: TypeAssertion): boolean => {
      const { inner, statements } = commentAnchorsOf(node);
      const anchors = [...inner, ...statements];

      if (anchors.some((anchor) => hasSafetyCommentBefore(context.sourceCode, anchor, node))) {
        return true;
      }

      disabledLines ??= disabledLinesOf(context.sourceCode);

      return isDisabledWithReason(disabledLines, statements, node);
    };

    const checkAssertion = (node: TypeAssertion) => {
      if (!isConstAssertion(node) && !isJustified(node)) {
        context.report({ node, messageId: 'missingSafetyComment' });
      }
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
};
