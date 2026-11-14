"""tree-sitter-cpp 语法事实、声明位置与已知动作。"""
from tree_sitter import Language, Parser
import tree_sitter_cpp

from code_lab.snapshots.initialization import safe_value


def walk(node):
    yield node
    for child in node.named_children:
        yield from walk(child)


class SourceFacts:
    def __init__(self, source):
        self.data = source.encode("utf-8")
        self.tree = Parser(Language(tree_sitter_cpp.language())).parse(self.data)
        self.declarations = {}
        self.actions = {}
        self.custom_callables = set()
        for node in walk(self.tree.root_node):
            if node.type in ("function_declarator", "preproc_function_def", "preproc_def"):
                name = node.child_by_field_name("declarator" if node.type == "function_declarator" else "name")
                if name is not None:
                    self.custom_callables.add(self.text(name))
            if node.type == "declaration":
                for declarator in node.children_by_field_name("declarator"):
                    base = declarator.child_by_field_name("declarator") if declarator.type == "init_declarator" else declarator
                    while base is not None and base.type != "identifier":
                        base = base.child_by_field_name("declarator")
                    if base is None:
                        continue
                    value = declarator.child_by_field_name("value")
                    name = self.text(base)
                    line = node.start_point.row + 1
                    self.declarations[(line, name)] = {"initialized": value is not None,
                                                       "node": node, "value": value}
                    self.add_action(node, name, value, "declare")
            elif node.type == "assignment_expression":
                left = node.child_by_field_name("left")
                if left and left.type == "identifier":
                    operator = node.child_by_field_name("operator")
                    self.add_action(node, self.text(left), node.child_by_field_name("right"),
                                    "assign" if operator and self.text(operator) == "=" else "update")
            elif node.type == "update_expression":
                argument = node.child_by_field_name("argument")
                if argument and argument.type == "identifier":
                    self.add_action(node, self.text(argument), argument, "update")
            elif node.type == "expression_statement" and node.named_child_count == 1:
                expression = node.named_children[0]
                targets = []
                while expression.type == "binary_expression":
                    operator = expression.child_by_field_name("operator")
                    right = expression.child_by_field_name("right")
                    if not operator or self.text(operator) != ">>" or right.type != "identifier":
                        break
                    targets.append(self.text(right))
                    expression = expression.child_by_field_name("left")
                stream = self.text(expression).replace(" ", "")
                if stream in ("cin", "std::cin", "::std::cin"):
                    for name in reversed(targets):
                        self.add_action(node, name, None, "input", stream)

    def text(self, node):
        return self.data[node.start_byte:node.end_byte].decode("utf-8")

    def add_action(self, node, name, value, kind, stream=None):
        # 多行、多语句、条件表达式、宏展开不作已初始化证明。
        line = node.start_point.row + 1
        ancestor = node.parent
        while ancestor is not None:
            if (ancestor.type in ("if_statement", "while_statement", "do_statement", "switch_statement",
                                  "conditional_expression") and ancestor.start_point.row + 1 == line):
                return
            ancestor = ancestor.parent
        parent = node
        while parent.parent and parent.parent.type not in ("compound_statement", "for_statement", "translation_unit"):
            parent = parent.parent
        if (parent.type not in ("declaration", "expression_statement", "update_expression")
                or parent.start_point.row != parent.end_point.row or node.has_error):
            return
        self.actions.setdefault(line, []).append({"name": name, "value": value,
                                                  "kind": kind, "statement": parent, "stream": stream})

    def safe_value(self, node, known, containers):
        """以当前语法事实验证表达式来源，不求值用户程序。"""
        return safe_value(self, node, known, containers)

    def index_relationships(self):
        """只沿直接下标与纯标量计算关联，按词法声明区分同名变量。"""
        def resolve(node):
            name = self.text(node)
            matches = []
            for (line, declared), fact in self.declarations.items():
                if declared != name or fact["node"].start_byte > node.start_byte:
                    continue
                scope = fact["node"].parent
                while scope.parent and scope.type not in ("compound_statement", "for_statement", "translation_unit"):
                    scope = scope.parent
                if scope.start_byte <= node.start_byte < scope.end_byte:
                    matches.append((scope.end_byte - scope.start_byte, -line, (line, name)))
            return min(matches)[2] if matches else None

        graph = {}
        direct = {}
        for node in walk(self.tree.root_node):
            if node.type == "subscript_expression":
                base = node.child_by_field_name("argument")
                indices = node.child_by_field_name("indices")
                if base is None or base.type != "identifier" or indices is None:
                    continue
                array = resolve(base)
                if array:
                    direct.setdefault(array, set()).update(resolve(part) for part in walk(indices) if part.type == "identifier")
            if node.type not in ("init_declarator", "assignment_expression"):
                continue
            left = node.child_by_field_name("declarator" if node.type == "init_declarator" else "left")
            right = node.child_by_field_name("value" if node.type == "init_declarator" else "right")
            operator = node.child_by_field_name("operator")
            if (left is None or left.type != "identifier" or right is None
                    or operator is not None and self.text(operator) != "="
                    or any(part.type in ("subscript_expression", "call_expression", "update_expression", "assignment_expression") for part in walk(right))):
                continue
            target = resolve(left)
            dependencies = {resolve(part) for part in walk(right) if part.type == "identifier"}
            for dependency in dependencies - {None, target}:
                graph.setdefault(target, set()).add(dependency)
                graph.setdefault(dependency, set()).add(target)
        for array, seeds in direct.items():
            seeds.discard(None)
            pending = list(seeds)
            while pending:
                for dependency in graph.get(pending.pop(), set()) - seeds - {None, array}:
                    seeds.add(dependency)
                    pending.append(dependency)
        return direct
