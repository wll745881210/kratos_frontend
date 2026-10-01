"""Python port of the universal-pgen expression engine.

Mirrors `usr_ext/universal/expr.h` (kratos trunk) exactly — same grammar,
same op codes, same IEEE-754 double semantics (division by zero -> inf,
domain errors -> nan, never raises for numeric ops). The C++ header is the
single source of truth; correctness is enforced by shared golden vectors
(`tests/golden/expr_vectors.json`) which a C++ harness
(`tests/golden/expr_cpp_harness.cpp`) also consumes.

Grammar (precedence low -> high):
  or    := and   ( ('||'|'or')  and )*
  and   := cmp   ( ('&&'|'and') cmp )*
  cmp   := add   ( cmpop add )?
  cmpop := '<'|'<='|'>'|'>='|'=='|'!=' |
           'lt'|'leq'|'gt'|'geq'|'eq'|'ne'|'neq'
  add   := mul   ( ('+'|'-') mul )*
  mul   := unary ( ('*'|'/') unary )*
  unary := ('-'|'!'|'not') unary | pow
  pow   := prim  ( '^' unary )?              (right assoc)
  prim  := number | ident | func '(' args ')' | '(' or ')'

Constants: pi, e.  Variables default: x, y, z, t, i, j, k (indices 0..6;
i/j/k are integer cell indices, enabling grid-scale white noise via rand).
Functions: sqrt exp log sin cos tan asin acos atan abs step floor
           tanh sinh cosh erf (1-arg); min max pow atan2 (2-arg);
           clamp (3-arg); rand(i,j,k,seed) (4-arg) = deterministic uniform
           deviate in [0,1): splitmix64(seed)->+i->+j->+k chain, args
           rounded half-to-even to int64.  step(a) = a>=0 ? 1:0.
Word operators (lt leq gt geq eq ne neq and or not) exist because kratos
par files cannot carry '='; they are reserved words.
Comparisons/logicals yield 1.0/0.0.
"""

from __future__ import annotations

import math
import re
from typing import Dict, List, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# Bytecode (op codes identical to the C++ enum)

(
    PUSH_C,
    PUSH_V,
    NEG,
    NOT,
    ADD,
    SUB,
    MUL,
    DIV,
    POW,
    SQRT,
    EXP,
    LOG,
    SIN,
    COS,
    TAN,
    ASIN,
    ACOS,
    ATAN,
    ABS,
    STEP,
    FLOOR,
    MIN2,
    MAX2,
    ATAN2,
    CLAMP,
    LT,
    LE,
    GT,
    GE,
    EQ,
    NE,
    AND,
    OR,
    TANH,
    SINH,
    COSH,
    ERF,
    RAND4,
) = range(38)

MAX_CODE = 1024
MAX_STACK = 32

Instr = Tuple[int, float]          # (op, arg)
Program = List[Instr]

DEFAULT_VARS: Dict[str, int] = {
    "x": 0, "y": 1, "z": 2, "t": 3, "i": 4, "j": 5, "k": 6,
}

# splitmix64 finalizer behind rand(); pure uint64 arithmetic,
# bit-identical to the C++ engine.
_MASK64 = (1 << 64) - 1


def _sm64(x: int) -> int:
    x = (x + 0x9E3779B97F4A7C15) & _MASK64
    x = ((x ^ (x >> 30)) * 0xBF58476D1CE4E5B9) & _MASK64
    x = ((x ^ (x >> 27)) * 0x94D049BB133111EB) & _MASK64
    return (x ^ (x >> 31)) & _MASK64

# strtod-compatible literals: 3.14159265358979323846 -> math.pi (same double)
PI = 3.14159265358979323846
E = 2.71828182845904523536


class ExprError(ValueError):
    """Parse/compile error; message format matches the C++ engine."""


# ---------------------------------------------------------------------------
# IEEE-754 double helpers (C++ semantics: no Python exceptions for math)


def _div(a: float, b: float) -> float:
    if b != 0.0:
        return a / b
    # IEEE 754: a / ±0.0 -> ±inf (sign = sign(a) xor sign(b)); 0/0 -> nan
    if a == 0.0 or math.isnan(a):
        return math.nan
    neg = (a < 0.0) != (math.copysign(1.0, b) < 0.0)
    return -math.inf if neg else math.inf


def _log(a: float) -> float:
    if a == 0.0:
        return -math.inf  # pole (matches C log(±0))
    if a < 0.0:
        return math.nan
    return math.log(a)


def _safe1(fn):
    def wrap(a: float) -> float:
        try:
            return fn(a)
        except (ValueError, OverflowError):
            # domain error -> nan; overflow -> ±inf (matches libm)
            if fn in (math.exp, math.sinh, math.cosh):
                return math.copysign(math.inf, a)
            return math.nan

    return wrap


def _pow(a: float, b: float) -> float:
    if a == 0.0 and b < 0.0:
        return math.inf  # pole
    try:
        return math.pow(a, b)
    except ValueError:
        return math.nan
    except OverflowError:
        return math.inf


# ---------------------------------------------------------------------------
# Evaluation


def evaluate(prog: Program, vars: Sequence[float]) -> float:
    st: List[float] = []
    push = st.append
    for op, arg in prog:
        if op == PUSH_C:
            push(float(arg))
        elif op == PUSH_V:
            push(vars[int(arg)])
        elif op == NEG:
            st[-1] = -st[-1]
        elif op == NOT:
            st[-1] = 1.0 if st[-1] == 0.0 else 0.0
        elif op == ADD:
            b = st.pop()
            st[-1] = st[-1] + b
        elif op == SUB:
            b = st.pop()
            st[-1] = st[-1] - b
        elif op == MUL:
            b = st.pop()
            st[-1] = st[-1] * b
        elif op == DIV:
            b = st.pop()
            st[-1] = _div(st[-1], b)
        elif op == POW:
            b = st.pop()
            st[-1] = _pow(st[-1], b)
        elif op == SQRT:
            st[-1] = _safe1(math.sqrt)(st[-1])
        elif op == EXP:
            st[-1] = _safe1(math.exp)(st[-1])
        elif op == LOG:
            st[-1] = _log(st[-1])
        elif op == SIN:
            st[-1] = math.sin(st[-1])
        elif op == COS:
            st[-1] = math.cos(st[-1])
        elif op == TAN:
            st[-1] = _safe1(math.tan)(st[-1])
        elif op == ASIN:
            st[-1] = _safe1(math.asin)(st[-1])
        elif op == ACOS:
            st[-1] = _safe1(math.acos)(st[-1])
        elif op == ATAN:
            st[-1] = _safe1(math.atan)(st[-1])
        elif op == ABS:
            st[-1] = abs(st[-1])
        elif op == STEP:
            st[-1] = 1.0 if st[-1] >= 0.0 else 0.0
        elif op == FLOOR:
            st[-1] = math.floor(st[-1])
        elif op == MIN2:
            b = st.pop()
            st[-1] = st[-1] if st[-1] < b else b
        elif op == MAX2:
            b = st.pop()
            st[-1] = st[-1] if st[-1] > b else b
        elif op == ATAN2:
            b = st.pop()
            st[-1] = math.atan2(st[-1], b)
        elif op == CLAMP:
            hi = st.pop()
            lo = st.pop()
            a = st[-1]
            st[-1] = lo if a < lo else (hi if a > hi else a)
        elif op == LT:
            b = st.pop()
            st[-1] = 1.0 if st[-1] < b else 0.0
        elif op == LE:
            b = st.pop()
            st[-1] = 1.0 if st[-1] <= b else 0.0
        elif op == GT:
            b = st.pop()
            st[-1] = 1.0 if st[-1] > b else 0.0
        elif op == GE:
            b = st.pop()
            st[-1] = 1.0 if st[-1] >= b else 0.0
        elif op == EQ:
            b = st.pop()
            st[-1] = 1.0 if st[-1] == b else 0.0
        elif op == NE:
            b = st.pop()
            st[-1] = 1.0 if st[-1] != b else 0.0
        elif op == AND:
            b = st.pop()
            st[-1] = 1.0 if (st[-1] != 0.0 and b != 0.0) else 0.0
        elif op == OR:
            b = st.pop()
            st[-1] = 1.0 if (st[-1] != 0.0 or b != 0.0) else 0.0
        elif op == TANH:
            st[-1] = math.tanh(st[-1])
        elif op == SINH:
            st[-1] = _safe1(math.sinh)(st[-1])
        elif op == COSH:
            st[-1] = _safe1(math.cosh)(st[-1])
        elif op == ERF:
            st[-1] = math.erf(st[-1])
        elif op == RAND4:
            # rand(i,j,k,seed): deterministic white noise in [0,1)
            vs = st.pop()
            vk = st.pop()
            vj = st.pop()
            vi = st.pop()
            h = _sm64(int(round(vs)) & _MASK64)
            h = _sm64((h + (int(round(vi)) & _MASK64)) & _MASK64)
            h = _sm64((h + (int(round(vj)) & _MASK64)) & _MASK64)
            h = _sm64((h + (int(round(vk)) & _MASK64)) & _MASK64)
            push((h >> 11) * (1.0 / 9007199254740992.0))
        else:  # pragma: no cover - unreachable for compiled programs
            raise ExprError(f"expr: bad opcode {op}")
        if len(st) > MAX_STACK:
            raise ExprError("expr: stack overflow (>32)")
    return st[0] if st else 0.0


# ---------------------------------------------------------------------------
# Parser


# strtod decimal / hex / inf-nan (leading sign included, like strtod).
# Order matters: hex must precede decimal ("0x10" would else tokenize as "0").
_RE_NUM = re.compile(
    r"[+-]?(?:"
    r"0[xX][0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?(?:[pP][+-]?\d+)?"  # hex
    r"|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?"  # decimal
    r"|inf(?:inity)?|nan"  # inf / nan
    r")",
    re.IGNORECASE,
)

_FUNC_TAB: Dict[str, Tuple[int, int]] = {
    "sqrt": (SQRT, 1),
    "exp": (EXP, 1),
    "log": (LOG, 1),
    "sin": (SIN, 1),
    "cos": (COS, 1),
    "tan": (TAN, 1),
    "asin": (ASIN, 1),
    "acos": (ACOS, 1),
    "atan": (ATAN, 1),
    "abs": (ABS, 1),
    "step": (STEP, 1),
    "floor": (FLOOR, 1),
    "min": (MIN2, 2),
    "max": (MAX2, 2),
    "pow": (POW, 2),
    "atan2": (ATAN2, 2),
    "clamp": (CLAMP, 3),
    "tanh": (TANH, 1),
    "sinh": (SINH, 1),
    "cosh": (COSH, 1),
    "erf": (ERF, 1),
    "rand": (RAND4, 4),
}

_CMP_OPS: List[Tuple[str, int]] = [
    ("<=", LE),
    (">=", GE),
    ("==", EQ),
    ("!=", NE),
    ("<", LT),
    (">", GT),
    ("geq", GE),
    ("leq", LE),
    ("neq", NE),
    ("ge", GE),
    ("le", LE),
    ("eq", EQ),
    ("ne", NE),
    ("lt", LT),
    ("gt", GT),
]

_IDENT_CHARS = set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_."
)


class _Parser:
    def __init__(self, src: str, vars: Dict[str, int]):
        self.src = src
        self.pos = 0
        self.vars = vars
        self.prog: Program = []

    # ----- lexer -----
    def _skip_ws(self) -> None:
        s, n = self.src, len(self.src)
        while self.pos < n and s[self.pos].isspace():
            self.pos += 1

    def _eat(self, lit: str) -> bool:
        """Match literal; word-boundary protection for alpha literals."""
        self._skip_ws()
        s, n = self.src, len(self.src)
        if s.startswith(lit, self.pos):
            if lit[0].isalpha():
                j = self.pos + len(lit)
                if j < n and (s[j].isalnum() or s[j] in "_."):
                    return False
            self.pos += len(lit)
            return True
        return False

    def _fail(self, msg: str) -> None:
        raise ExprError(
            f'expr: {msg} (at byte {self.pos} of "{self.src}")'
        )

    def _emit(self, op: int, arg: float = 0.0) -> None:
        self.prog.append((op, arg))

    # ----- grammar -----
    def parse_or(self) -> None:
        self.parse_and()
        while self._eat("||") or self._eat("or"):
            self.parse_and()
            self._emit(OR)

    def parse_and(self) -> None:
        self.parse_cmp()
        while self._eat("&&") or self._eat("and"):
            self.parse_cmp()
            self._emit(AND)

    def parse_cmp(self) -> None:
        self.parse_add()
        for lit, op in _CMP_OPS:
            if self._eat(lit):
                self.parse_add()
                self._emit(op)
                return

    def parse_add(self) -> None:
        self.parse_mul()
        while True:
            if self._eat("+"):
                self.parse_mul()
                self._emit(ADD)
            elif self._eat("-"):
                self.parse_mul()
                self._emit(SUB)
            else:
                return

    def parse_mul(self) -> None:
        self.parse_unary()
        while True:
            if self._eat("*"):
                self.parse_unary()
                self._emit(MUL)
            elif self._eat("/"):
                self.parse_unary()
                self._emit(DIV)
            else:
                return

    def parse_unary(self) -> None:
        if self._eat("-"):
            self.parse_unary()
            self._emit(NEG)
        elif self._eat("!") or self._eat("not"):
            self.parse_unary()
            self._emit(NOT)
        else:
            self.parse_pow()

    def parse_pow(self) -> None:
        self.parse_prim()
        if self._eat("^"):
            self.parse_unary()  # right associative
            self._emit(POW)

    def parse_prim(self) -> None:
        self._skip_ws()
        s, n = self.src, len(self.src)
        if self.pos >= n:
            self._fail("unexpected end")

        if self._eat("("):
            self.parse_or()
            if not self._eat(")"):
                self._fail("missing ')'")
            return

        # number (strtod semantics: sign, decimal, hex, inf/nan)
        m = _RE_NUM.match(s, self.pos)
        if m:
            tok = m.group(0)
            self.pos = m.end()
            low = tok.lower().lstrip("+-")
            if low.startswith("0x"):
                v = float.fromhex(tok)
            elif "inf" in low:
                v = math.inf if not tok.startswith("-") else -math.inf
            elif "nan" in low:
                v = math.nan
            else:
                v = float(tok)
            self._emit(PUSH_C, v)
            return

        # identifier / constant / function
        c = s[self.pos]
        if c.isalpha() or c == "_":
            j = self.pos
            while j < n and s[j] in _IDENT_CHARS:
                j += 1
            name = s[self.pos : j]
            self.pos = j

            if name == "pi":
                self._emit(PUSH_C, PI)
                return
            if name == "e":
                self._emit(PUSH_C, E)
                return

            self._skip_ws()
            if self.pos < n and s[self.pos] == "(":
                fn = _FUNC_TAB.get(name)
                if fn is None:
                    self._fail(f"unknown function '{name}'")
                self.pos += 1  # consume '('
                for a in range(fn[1]):
                    if a > 0 and not self._eat(","):
                        self._fail(f"missing ',' in {name}()")
                    self.parse_or()
                if not self._eat(")"):
                    self._fail(f"missing ')' in {name}()")
                self._emit(fn[0])
                return

            if name not in self.vars:
                self._fail(f"unknown variable '{name}'")
            self._emit(PUSH_V, float(self.vars[name]))
            return

        self._fail("unexpected character")


def compile(
    s: str, vars: Optional[Dict[str, int]] = None
) -> Program:  # noqa: A001 - mirrors C++ univ::expr::compile
    """Compile an expression to bytecode. Raises ExprError on bad input."""
    if vars is None:
        vars = DEFAULT_VARS
    if not s:
        raise ExprError(f'expr: empty expression (at byte 0 of "{s}")')
    p = _Parser(s, vars)
    p.parse_or()
    p._skip_ws()
    if p.pos != len(p.src):
        p._fail("trailing characters")
    if len(p.prog) > MAX_CODE:
        p._fail("expression too long")
    return p.prog


def eval_expr(s: str, vars: Sequence[float]) -> float:
    """Compile + evaluate convenience wrapper."""
    return evaluate(compile(s), vars)
