"""FastAPI server for the kratos graphical frontend (M2).

Thin shell over the pure-Python ``kratos_spec`` core: the server is the
authoritative validator; the browser client never re-implements par
parsing.  Localhost-only, no auth (personal tool).
"""

__version__ = "0.1.0"
