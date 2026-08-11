# Throwaway helper for the Japanese GUI sweep. Applies exact-match string
# replacements to a source file and fails loudly if any pattern does not
# appear exactly once — so a silently-missed edit is impossible.
import io, sys, json

def apply(path, subs):
    s = io.open(path, encoding='utf-8').read()
    for a, b in subs:
        n = s.count(a)
        if n != 1:
            print('MISS(%d): %r' % (n, a[:90]))
            sys.exit(1)
        s = s.replace(a, b)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print('ok %s (%d edits)' % (path, len(subs)))

if __name__ == '__main__':
    spec = json.load(io.open(sys.argv[1], encoding='utf-8'))
    apply(spec['path'], [(x[0], x[1]) for x in spec['subs']])
