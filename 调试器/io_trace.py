"""编译期观测标准 C++ 流；代理保留原 streambuf 及其缓冲语义。"""

LINK_FLAGS = tuple("-Wl,--wrap=" + name for name in (
    "_ZNSt8ios_base15sync_with_stdioEb", "scanf", "__mingw_scanf", "getchar", "fgetc", "getc", "fgets", "fread"))

HEADER = r'''
#ifndef CODE_LAB_IO_TRACE
#define CODE_LAB_IO_TRACE
#include <iostream>
#include <fstream>
#include <iterator>
#include <cstdio>
#include <string>
#include <cstdarg>
namespace code_lab_io {
static std::string input_bytes;
static long long consumed = 0;
static bool input_ok = true;
static bool output_ok = true;
static bool synchronized = true;
static long long output_count = 0;
static void save_input() {
    if (FILE* f = std::fopen("input-trace.txt", "wb")) {
        std::fprintf(f, "%d %lld\n", input_ok ? 1 : 0, consumed);
        std::fclose(f);
    }
}
static void consume(char c) {
    if (consumed < static_cast<long long>(input_bytes.size()) && input_bytes[consumed] == c) {
        ++consumed;
    } else if (c == '\n' && consumed + 1 < static_cast<long long>(input_bytes.size()) &&
               input_bytes[consumed] == '\r' && input_bytes[consumed + 1] == '\n') {
        consumed += 2;
    } else {
        input_ok = false;
    }
}
static void c_input(FILE* stream) {
    if (stream != stdin) { return; }
    long offset = std::ftell(stream);
    if (offset >= 0 && offset <= static_cast<long long>(input_bytes.size()) && synchronized) {
        consumed = offset;
    } else { input_ok = false; }
    save_input();
}
static void mirror(const char* p, std::streamsize n) {
    if (!output_ok || n <= 0) { return; }
    std::string physical;
    for (std::streamsize i = 0; i < n; ++i) {
#ifdef _WIN32
        if (p[i] == '\n') { physical += '\r'; }
#endif
        physical += p[i];
    }
    if (FILE* f = std::fopen("stdout-trace.txt", "ab")) {
        if (std::fwrite(physical.data(), 1, physical.size(), f) != physical.size()) {
            output_ok = false;
        }
        std::fclose(f);
        output_count += physical.size();
    } else { output_ok = false; }
}
class observed_buffer : public std::streambuf {
public:
    std::streambuf* original = nullptr;
    bool input;
    explicit observed_buffer(bool is_input) : input(is_input) {}
protected:
    int_type underflow() override { return original->sgetc(); }
    int_type uflow() override {
        int_type c = original->sbumpc();
        if (!traits_type::eq_int_type(c, traits_type::eof())) {
            consume(traits_type::to_char_type(c));
            save_input();
        }
        return c;
    }
    std::streamsize xsgetn(char* p, std::streamsize n) override {
        std::streamsize read = original->sgetn(p, n);
        for (std::streamsize i = 0; i < read; ++i) { consume(p[i]); }
        save_input();
        return read;
    }
    int_type pbackfail(int_type c) override {
        int_type result = traits_type::eq_int_type(c, traits_type::eof())
            ? original->sungetc() : original->sputbackc(traits_type::to_char_type(c));
        if (!traits_type::eq_int_type(result, traits_type::eof())) {
            if (consumed > 0) {
                --consumed;
                if (input_bytes[consumed] == '\n' && consumed > 0 && input_bytes[consumed - 1] == '\r') { --consumed; }
            } else { input_ok = false; }
            save_input();
        }
        return result;
    }
    std::streamsize xsputn(const char* p, std::streamsize n) override {
        check_output();
        std::streamsize written = original->sputn(p, n);
        mirror(p, written);
        return written;
    }
    int_type overflow(int_type c) override {
        if (traits_type::eq_int_type(c, traits_type::eof())) { return traits_type::not_eof(c); }
        check_output();
        int_type result = original->sputc(traits_type::to_char_type(c));
        if (!traits_type::eq_int_type(result, traits_type::eof())) {
            char value = traits_type::to_char_type(c);
            mirror(&value, 1);
        }
        return result;
    }
    void check_output() {
        // 同步模式下 ftell 包含 C FILE 未刷出的数据，可识别 printf 混用。
        if (synchronized && std::ftell(stdout) != output_count) {
            output_ok = false;
            if (FILE* f = std::fopen("stdout-trace-unavailable.txt", "wb")) { std::fclose(f); }
        }
    }
    int sync() override { return original->pubsync(); }
    std::streamsize showmanyc() override { return original->in_avail(); }
    pos_type seekoff(off_type off, std::ios_base::seekdir way, std::ios_base::openmode mode) override {
        pos_type result = original->pubseekoff(off, way, mode);
        track_seek(result, off == 0 && way == std::ios_base::cur);
        return result;
    }
    pos_type seekpos(pos_type position, std::ios_base::openmode mode) override {
        pos_type result = original->pubseekpos(position, mode);
        track_seek(result, false);
        return result;
    }
    void track_seek(pos_type position, bool query) {
        if (input && !query && position != pos_type(off_type(-1))) {
            long long offset = static_cast<off_type>(position);
            if (offset >= 0 && offset <= static_cast<long long>(input_bytes.size())) { consumed = offset; }
            else { input_ok = false; }
            save_input();
        }
    }
    void imbue(const std::locale& locale) override { original->pubimbue(locale); }
};
static observed_buffer input_buffer(true);
static observed_buffer output_buffer(false);
class stream_access : public std::istream {
public:
    static std::streambuf** slot(std::istream& stream) {
        auto member = &stream_access::_M_streambuf;
        return &(stream.*member);
    }
    static std::ios_base::iostate* state_slot(std::istream& stream) {
        auto member = &stream_access::_M_streambuf_state;
        return &(stream.*member);
    }
};
static std::streambuf** input_slot = stream_access::slot(std::cin);
static std::ios_base::iostate* input_state = stream_access::state_slot(std::cin);
static int input_failure_bits = std::ios_base::failbit | std::ios_base::badbit;
static void attach() {
    if (std::cin.rdbuf() != &input_buffer) { input_buffer.original = std::cin.rdbuf(); std::cin.rdbuf(&input_buffer); }
    if (std::cout.rdbuf() != &output_buffer) { output_buffer.original = std::cout.rdbuf(); std::cout.rdbuf(&output_buffer); }
}
class installation {
public:
    installation() {
        std::ifstream source("input.txt", std::ios::binary);
        input_bytes.assign(std::istreambuf_iterator<char>(source), std::istreambuf_iterator<char>());
        save_input();
        attach();
    }
    ~installation() {
        if (std::cin.rdbuf() != &input_buffer) { input_ok = false; }
        save_input();
        if (std::cin.rdbuf() == &input_buffer) { std::cin.rdbuf(input_buffer.original); }
        if (std::cout.rdbuf() == &output_buffer) { std::cout.rdbuf(output_buffer.original); }
    }
};
static installation installed;
}
extern "C" bool code_lab_real_sync(bool) asm("__real__ZNSt8ios_base15sync_with_stdioEb");
extern "C" bool code_lab_wrap_sync(bool) asm("__wrap__ZNSt8ios_base15sync_with_stdioEb");
extern "C" bool code_lab_wrap_sync(bool enabled) {
    bool previous = code_lab_real_sync(enabled);
    code_lab_io::synchronized = enabled;
    code_lab_io::attach();
    return previous;
}
extern "C" int __wrap_scanf(const char* format, ...) {
    va_list arguments;
    va_start(arguments, format);
    int result = std::vscanf(format, arguments);
    va_end(arguments);
    code_lab_io::c_input(stdin);
    return result;
}
#ifdef _WIN32
extern "C" int __wrap___mingw_scanf(const char* format, ...) {
    va_list arguments;
    va_start(arguments, format);
    int result = std::vscanf(format, arguments);
    va_end(arguments);
    code_lab_io::c_input(stdin);
    return result;
}
#endif
extern "C" int __real_getchar();
extern "C" int __wrap_getchar() {
    int result = __real_getchar();
    code_lab_io::c_input(stdin);
    return result;
}
extern "C" int __real_fgetc(FILE*);
extern "C" int __wrap_fgetc(FILE* stream) {
    int result = __real_fgetc(stream);
    code_lab_io::c_input(stream);
    return result;
}
extern "C" int __real_getc(FILE*);
extern "C" int __wrap_getc(FILE* stream) {
    int result = __real_getc(stream);
    code_lab_io::c_input(stream);
    return result;
}
extern "C" char* __real_fgets(char*, int, FILE*);
extern "C" char* __wrap_fgets(char* buffer, int size, FILE* stream) {
    char* result = __real_fgets(buffer, size, stream);
    code_lab_io::c_input(stream);
    return result;
}
extern "C" std::size_t __real_fread(void*, std::size_t, std::size_t, FILE*);
extern "C" std::size_t __wrap_fread(void* buffer, std::size_t size, std::size_t count, FILE* stream) {
    std::size_t result = __real_fread(buffer, size, count, stream);
    code_lab_io::c_input(stream);
    return result;
}
#endif
'''
