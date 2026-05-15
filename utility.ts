export const EXPRESSION_NODE_TYPES = new Set([
    'AssignmentExpression',
    'Await',
    'BinaryOperation',
    'Call',
    'Comprehension',
    'Constant',
    'Dictionary',
    'DictionaryExpandEntry',
    'DictionaryKeyEntry',
    'Ellipsis',
    'Error',
    'FormatString',
    'Index',
    'Lambda',
    'List',
    'MemberAccess',
    'ModuleName',
    'Name',
    'Number',
    'Set',
    'Slice',
    'String',
    'StringList',
    'Ternary',
    'Tuple',
    'UnaryOperation',
    'Unpack',
    'Yield',
    'YieldFrom',
]);

export const IDENT_NODE_TYPES = new Set([
    'AssignmentExpression',
    'Call',
    'MemberAccess',
]);

export const ANNO_NODE_TYPES = new Set([
    'AssignmentExpression',
    'Param',
]);
