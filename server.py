#!/usr/bin/env python3
"""Pyratik — yerel önizleme sunucusu. Yalnızca standart kütüphane kullanır.

Başlat:  python3 server.py   →   http://127.0.0.1:8765

Kod bu sunucuda çalışmaz. Python, ziyaretçinin tarayıcısında (Pyodide,
WebAssembly) sayfadan ayrı bir Web Worker içinde çalışır (worker.js). Bu
sunucu yalnızca sayfanın dosyalarını sunar; yayındaki sürüm de aynı dosyalardır.
"""
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HOST, PORT = "127.0.0.1", 8765
HERE = os.path.dirname(os.path.abspath(__file__))

FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/worker.js": ("worker.js", "text/javascript; charset=utf-8"),
    "/assets/pyratik_logo.svg": ("assets/pyratik_logo.svg", "image/svg+xml"),
    "/assets/favicon.png": ("assets/favicon.png", "image/png"),
}


class Handler(BaseHTTPRequestHandler):
    server_version = "Pyratik"

    def do_GET(self):
        entry = FILES.get(urlparse(self.path).path)
        if entry is None:
            code, ctype, body = 404, "text/plain; charset=utf-8", "Bulunamadı".encode("utf-8")
        else:
            with open(os.path.join(HERE, entry[0]), "rb") as f:
                code, ctype, body = 200, entry[1], f.read()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Pyratik hazır → http://{HOST}:{PORT}   (durdurmak için Ctrl+C)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nSunucu durduruldu.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
