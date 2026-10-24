/* 离线 C++11/14 词法着色；仅表达词法形态，不推断类型或程序含义。 */
(function (global) {
  'use strict';

  const keywords = new Set(('alignas alignof and and_eq asm bitand bitor break case catch class compl const constexpr const_cast continue default delete do dynamic_cast else enum explicit export extern false for friend goto if inline mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast return sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union using virtual volatile while xor xor_eq final override').split(' '));
  const types = new Set(('auto bool char char16_t char32_t decltype double float int long short signed unsigned void wchar_t string wstring u16string u32string vector array deque list forward_list map multimap unordered_map unordered_multimap set multiset unordered_set unordered_multiset stack queue priority_queue pair tuple size_t ptrdiff_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t').split(' '));
  const isIdentifierStart = (character) => !!character && /[A-Za-z_\u0080-\uffff]/.test(character);
  const isIdentifierPart = (character) => !!character && /[A-Za-z_0-9\u0080-\uffff]/.test(character);
  const isDigit = (character) => !!character && character >= '0' && character <= '9';

  function highlight(input) {
    const source = String(input == null ? '' : input);
    const lines = [document.createDocumentFragment()];
    let position = 0;
    let lineOnlySpace = true;
    let includeHeader = false;

    // 行分隔符属于调用者：用 fragments.map(f => f.textContent).join('\n') 精确还原。
    // CRLF 中的 CR 原样保留，末尾 LF 产生最后一个空 Fragment。
    function emit(start, end, kind) {
      const parts = source.slice(start, end).split('\n');
      for (let index = 0; index < parts.length; index++) {
        if (index) lines.push(document.createDocumentFragment());
        const text = parts[index];
        if (text) {
          if (kind) {
            const span = document.createElement('span');
            span.className = 'token-' + kind;
            span.textContent = text;
            lines[lines.length - 1].appendChild(span);
          } else {
            lines[lines.length - 1].appendChild(document.createTextNode(text));
          }
        }
      }
    }

    function quotedEnd(quoteIndex) {
      const quote = source[quoteIndex];
      let cursor = quoteIndex + 1;
      while (cursor < source.length) {
        const character = source[cursor];
        if (character === '\\') {
          cursor += source[cursor + 1] === '\r' && source[cursor + 2] === '\n' ? 3 : 2;
        } else if (character === quote) {
          return cursor + 1;
        } else if (character === '\n' || character === '\r') {
          return cursor;
        } else {
          cursor++;
        }
      }
      return source.length;
    }

    function literalEnd(start) {
      // 先识别 raw string，再识别普通字符串/字符；前缀必须处于 token 边界。
      let prefix = 0;
      if (source.startsWith('u8', start)) prefix = 2;
      else if ('uUL'.includes(source[start])) prefix = 1;
      const raw = start + prefix;
      if (source[raw] === 'R' && source[raw + 1] === '"') {
        let open = raw + 2;
        while (open < source.length && open - (raw + 2) <= 16 && !/[\s()\\]/.test(source[open])) open++;
        if (source[open] === '(' && open - (raw + 2) <= 16) {
          const delimiter = source.slice(raw + 2, open);
          const close = source.indexOf(')' + delimiter + '"', open + 1);
          return close < 0 ? source.length : close + delimiter.length + 2;
        }
      }
      const quote = start + prefix;
      if (source[quote] === '"' || source[quote] === "'") return quotedEnd(quote);
      // u8 字符字面量不属于 C++11/14；仍以普通字符文本安全展示。
      return 0;
    }

    function numberEnd(start) {
      let cursor = start;
      let hexadecimal = false;
      let binary = false;
      if (source[start] === '0' && /[xX]/.test(source[start + 1] || '')) {
        hexadecimal = true;
        cursor += 2;
      } else if (source[start] === '0' && /[bB]/.test(source[start + 1] || '')) {
        binary = true;
        cursor += 2;
      }
      const digit = hexadecimal ? /[0-9a-fA-F']/ : binary ? /[01']/ : /[0-9']/;
      while (cursor < source.length && digit.test(source[cursor])) cursor++;
      if (!binary && source[cursor] === '.') {
        cursor++;
        while (cursor < source.length && digit.test(source[cursor])) cursor++;
      }
      const exponent = hexadecimal ? /[pP]/ : /[eE]/;
      if (!binary && exponent.test(source[cursor] || '')) {
        let next = cursor + 1;
        if (source[next] === '+' || source[next] === '-') next++;
        if (isDigit(source[next])) {
          cursor = next + 1;
          while (cursor < source.length && /[0-9']/.test(source[cursor])) cursor++;
        }
      }
      // 标准后缀及用户自定义字面量后缀保持同一 token，不转成 JS 数字。
      while (isIdentifierPart(source[cursor])) cursor++;
      return cursor;
    }

    while (position < source.length) {
      const start = position;
      const character = source[position];
      if (/\s/.test(character)) {
        while (position < source.length && /\s/.test(source[position])) {
          if (source[position] === '\n') {
            lineOnlySpace = true;
            // include 头文件不跨越未续接的物理行。
            if (source[position - 1] !== '\\' && !(source[position - 1] === '\r' && source[position - 2] === '\\')) includeHeader = false;
          }
          position++;
        }
        emit(start, position);
        continue;
      }
      if (source.startsWith('//', position)) {
        position += 2;
        // 翻译阶段的反斜杠续行也作用于行注释。
        while (position < source.length) {
          if (source[position] === '\n' && source[position - 1] !== '\\' && !(source[position - 1] === '\r' && source[position - 2] === '\\')) break;
          position++;
        }
        emit(start, position, 'comment');
        continue;
      }
      if (source.startsWith('/*', position)) {
        const close = source.indexOf('*/', position + 2);
        position = close < 0 ? source.length : close + 2;
        if (source.slice(start, position).includes('\n')) {
          lineOnlySpace = true;
          includeHeader = false;
        }
        emit(start, position, 'comment');
        continue;
      }
      if (character === '#' && lineOnlySpace) {
        position++;
        while (source[position] === ' ' || source[position] === '\t') position++;
        const directive = position;
        while (isIdentifierPart(source[position])) position++;
        includeHeader = source.slice(directive, position) === 'include';
        lineOnlySpace = false;
        emit(start, position, 'preprocessor');
        continue;
      }
      if (includeHeader && character === '<') {
        position++;
        while (position < source.length && source[position] !== '>' && source[position] !== '\n' && source[position] !== '\r') position++;
        if (source[position] === '>') position++;
        includeHeader = false;
        lineOnlySpace = false;
        emit(start, position, 'string');
        continue;
      }
      const literal = literalEnd(position);
      if (literal) {
        position = literal;
        includeHeader = false;
        lineOnlySpace = false;
        emit(start, position, 'string');
        continue;
      }
      if (isDigit(character) || (character === '.' && isDigit(source[position + 1]))) {
        position = numberEnd(position);
        lineOnlySpace = false;
        includeHeader = false;
        emit(start, position, 'number');
        continue;
      }
      if (isIdentifierStart(character)) {
        position++;
        while (isIdentifierPart(source[position])) position++;
        const identifier = source.slice(start, position);
        let kind = keywords.has(identifier) ? 'keyword' : types.has(identifier) ? 'type' : null;
        let next = position;
        while (next < source.length && /\s/.test(source[next])) next++;
        if (!kind && source[next] === '(') kind = 'function';
        lineOnlySpace = false;
        includeHeader = false;
        emit(start, position, kind);
        continue;
      }
      position++;
      // include 的反斜杠换行不提前清掉头文件等待状态。
      if (character !== '\\') includeHeader = false;
      lineOnlySpace = false;
      emit(start, position);
    }
    return lines;
  }

  global.CodeSyntax = Object.freeze({ highlight });
})(window);
