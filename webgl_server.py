import http.server
import socketserver
import os
import sys

PORT = 8080

class UnityWebGLHTTPHandler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        lp = path.lower()
        if lp.endswith('.wasm') or '.wasm.' in lp:
            return 'application/wasm'
        if lp.endswith('.js') or '.js.' in lp:
            return 'application/javascript'
        if lp.endswith('.data') or '.data.' in lp:
            return 'application/octet-stream'
        if lp.endswith('.css'):
            return 'text/css'
        if lp.endswith('.html') or lp.endswith('.htm'):
            return 'text/html'
        if lp.endswith('.png'):
            return 'image/png'
        if lp.endswith('.jpg') or lp.endswith('.jpeg'):
            return 'image/jpeg'
        if lp.endswith('.ico'):
            return 'image/x-icon'
        return super().guess_type(path)

    def end_headers(self):
        path = self.translate_path(self.path)
        lower_path = path.lower()
        if lower_path.endswith('.unityweb') or lower_path.endswith('.gz'):
            self.send_header('Content-Encoding', 'gzip')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == '__main__':
    target_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    os.chdir(target_dir)
    with ThreadingHTTPServer(("", PORT), UnityWebGLHTTPHandler) as httpd:
        print(f"SporeTD WebGL Server running on http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
