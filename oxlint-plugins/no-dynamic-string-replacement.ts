/**
 * Oxlint plugin: no-dynamic-string-replacement.
 *
 * `String#replace` and `String#replaceAll` expand `$&`, `` $` ``, `$'`, `$n`
 * and `$<name>` in a string replacement. When runtime code splices rendered
 * output with a dynamic replacement string, data inside that string — page
 * props, request values, collected head tags — can copy other parts of the
 * document into the result, e.g. a `` $` `` in page data duplicating the whole
 * document prefix inside `__NEXT_DATA__`.
 *
 * The replacement must therefore be a static string, whose patterns are
 * visible in review, or a function, whose return value is inserted verbatim.
 */
import { definePlugin, defineRule, type ESTree, type Scope, type Variable } from "@oxlint/plugins";

const REPLACE_METHODS = new Set(["replace", "replaceAll"]);
// Global functions that are safe to pass by reference.
const GLOBAL_FUNCTIONS = new Set(["encodeURI", "encodeURIComponent"]);

function findVariable(scope: Scope | null, name: string): Variable | null {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable) return variable;
  }
  return null;
}

/** The value of a string literal or an expression-free template literal. */
function getStaticString(node: ESTree.Node): string | null {
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function isFunctionNode(node: ESTree.Node | null | undefined): boolean {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

/** True when the identifier is bound to a function in this file. */
function isFunctionBinding(variable: Variable): boolean {
  const definition = variable.defs[0];
  if (!definition) return false;
  if (definition.type === "FunctionName") return true;
  if (definition.type === "Variable") {
    // A `let` could be reassigned a string after its declaration.
    const declaration = definition.parent as ESTree.VariableDeclaration | null;
    const declarator = definition.node as ESTree.VariableDeclarator;
    return declaration?.kind === "const" && isFunctionNode(declarator.init);
  }
  if (definition.type === "Parameter") {
    const annotation = (definition.name as ESTree.BindingIdentifier).typeAnnotation;
    return annotation?.typeAnnotation.type === "TSFunctionType";
  }
  return false;
}

const rule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a static string or a function as the String#replace replacement so inserted data is never expanded as $-patterns.",
    },
  },
  createOnce(context) {
    function isSafeReplacement(node: ESTree.Node): boolean {
      if (getStaticString(node) !== null) return true;
      if (isFunctionNode(node)) return true;
      if (node.type === "Identifier") {
        if (context.sourceCode.isGlobalReference(node)) return GLOBAL_FUNCTIONS.has(node.name);
        const variable = findVariable(context.sourceCode.getScope(node), node.name);
        return variable !== null && isFunctionBinding(variable);
      }
      return false;
    }

    function report(node: ESTree.Node): void {
      context.report({
        node,
        message:
          "Pass a function (or a static string) as the replacement: String#replace expands `$&`, `` $` `` and `$'` inside dynamic strings, letting inserted data rewrite the output.",
      });
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        const property = callee.property;
        const methodName = callee.computed
          ? getStaticString(property)
          : property.type === "Identifier"
            ? property.name
            : null;
        if (methodName === null || !REPLACE_METHODS.has(methodName)) return;
        // A spread that could supply the replacement can't be shown to be a
        // static string or a function.
        const spread = node.arguments.slice(0, 2).find((arg) => arg.type === "SpreadElement");
        if (spread) {
          report(spread);
          return;
        }
        // Without type information the Pages router's `replace(url, as)` looks
        // the same; its call sites carry a targeted disable comment.
        const replacement = node.arguments[1];
        if (!replacement) return;
        if (!isSafeReplacement(replacement)) report(replacement);
      },
    };
  },
});

export default definePlugin({
  meta: { name: "vinext-security" },
  rules: { "no-dynamic-string-replacement": rule },
});
