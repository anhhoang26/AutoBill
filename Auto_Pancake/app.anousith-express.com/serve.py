import http.server
import socketserver
import os

PORT = 8080 # Bạn có thể đổi cổng nếu muốn

class HtmlExtensionHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        """Serve a GET request."""
        path = self.translate_path(self.path)

        # Kiểm tra xem đường dẫn có tồn tại không
        if not os.path.exists(path):
            # Nếu không tồn tại, thử thêm '.html'
            html_path = path + ".html"
            if os.path.exists(html_path) and os.path.isfile(html_path):
                # Nếu tệp .html tồn tại, cập nhật đường dẫn nội bộ
                # để SimpleHTTPRequestHandler xử lý nó
                # Cần phải decode và encode lại path để xử lý query string
                parts = self.path.split('?', 1)
                new_path_part = parts[0] + ".html"
                if len(parts) > 1:
                    self.path = new_path_part + '?' + parts[1]
                else:
                    self.path = new_path_part
                # Gọi lại phương thức gốc với đường dẫn đã sửa
                return http.server.SimpleHTTPRequestHandler.do_GET(self)

        # Nếu đường dẫn gốc tồn tại hoặc tệp .html không tồn tại,
        # sử dụng hành vi mặc định
        return http.server.SimpleHTTPRequestHandler.do_GET(self)

# Chạy server
with socketserver.TCPServer(("", PORT), HtmlExtensionHandler) as httpd:
    print(f"Serving HTTP on 0.0.0.0 port {PORT} (http://0.0.0.0:{PORT}/) ...")
    print("Added logic to automatically check for .html files.")
    httpd.serve_forever()
