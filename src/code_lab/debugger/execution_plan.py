"""按原始源码范围生成真实执行检查点，不计算学生表达式。"""
from code_lab.snapshots.source_facts import SourceFacts

HEADER = '''#line 1 "code_lab_trace.hpp"
#include <utility>
#include <exception>
namespace code_lab_trace {
__attribute__((noinline)) void checkpoint(int site, int phase) {
    volatile int sink = site + phase;
    (void)sink;
}
bool test(int site, bool value) { checkpoint(site, 1); return value; }
template<class T> T returned(int site, T&& value) {
    checkpoint(site, 1); return std::forward<T>(value);
}
struct ReturnGuard {
    int site;
    ~ReturnGuard() { if (!std::uncaught_exception()) { checkpoint(site, 1); } }
};
}
#line 1 "main.cpp"
'''

class ExecutionPlan:
    def __init__(self, code):
        self.facts = SourceFacts(code)
        self.sites = {}

    def site(self, node, kind):
        number = len(self.sites) + 1
        self.sites[number] = dict(line=node.start_point.row + 1, end=node.end_point.row + 1,
                                  kind=kind, text=self.facts.text(node), node=node)
        return number

    def point(self, site, phase):
        return f'::code_lab_trace::checkpoint({site},{phase})'

    def replace(self, node, changes):
        value = self.facts.data[node.start_byte:node.end_byte]
        for child, replacement in sorted(changes, key=lambda pair: pair[0].start_byte, reverse=True):
            value = value[:child.start_byte-node.start_byte] + replacement.encode('utf-8') + value[child.end_byte-node.start_byte:]
        return value.decode('utf-8')

    def render(self, node):
        field = node.child_by_field_name
        if node.type == 'function_definition' and any(self.facts.text(child) == 'constexpr' for child in node.children):
            return self.facts.text(node)
        if node.type == 'for_statement':
            changes = []
            initializer, condition, update = field('initializer'), field('condition'), field('update')
            init = self.site(initializer, 'initialize') if initializer else None
            test = self.site(condition, 'condition') if condition else None
            if condition:
                prefix = self.point(init, 1) + ',' if init else ''
                changes.append((condition, '(' + prefix + self.point(test, 0) + ',::code_lab_trace::test(' + str(test) + ',bool(' + self.facts.text(condition) + ')))'))
            if update:
                site = self.site(update, 'update')
                changes.append((update, '(' + self.point(site,0) + ',' + self.facts.text(update) + ',' + self.point(site,1) + ')'))
            body = field('body')
            changes.append((body, self.render(body)))
            result = self.replace(node, changes)
            if init:
                result = self.point(init,0) + ';' + result
            return '{' + result + '}'
        if node.type in ('if_statement', 'while_statement', 'do_statement'):
            condition = field('condition')
            if condition and condition.type == 'condition_clause':
                condition = condition.child_by_field_name('value')
            # C++11/14 的 condition-declaration 具有自己的声明作用域，不能
            # 放进 bool(...) 表达式；否则会生成非法的 bool(int a = 1)。
            # 保留原语法，等后续专门的条件声明探针接入后再记录其证据。
            if condition and condition.type == 'declaration':
                return self.facts.text(node)
            changes = []
            for child in node.named_children:
                if condition and child.start_byte <= condition.start_byte < condition.end_byte <= child.end_byte:
                    site = self.site(condition, 'condition')
                    replacement = '(' + self.point(site,0) + ',::code_lab_trace::test(' + str(site) + ',bool(' + self.facts.text(condition) + ')))'
                    changes.append((condition, replacement))
                else:
                    changes.append((child, self.render(child)))
            return self.replace(node, changes)
        if node.type in ('declaration', 'expression_statement', 'return_statement', 'break_statement', 'continue_statement'):
            if node.type == 'declaration' and any(self.facts.text(child) == 'static' for child in node.children) and not any(child.type == 'init_declarator' for child in node.named_children):
                return self.facts.text(node)
            # 仅函数体内的语句；全局和类型定义保持原样。
            parent = node.parent
            function = False
            while parent:
                if parent.type == 'function_definition':
                    function = True
                    break
                parent = parent.parent
            if not function:
                return self.facts.text(node)
            site = self.site(node, node.type)
            prefix = self.point(site,0) + ';'
            result = self.facts.text(node)
            if node.type == 'return_statement':
                return '{::code_lab_trace::ReturnGuard __code_lab_return_' + str(site) + '{' + str(site) + '};' + prefix + result + '}'
            elif node.type in ('declaration', 'expression_statement'):
                result += self.point(site,1) + ';'
            result = prefix + result
            return result if node.parent.type == 'compound_statement' else '{' + result + '}'
        return self.replace(node, [(child, self.render(child)) for child in node.named_children])

    def generate(self):
        return HEADER + self.render(self.facts.tree.root_node)
