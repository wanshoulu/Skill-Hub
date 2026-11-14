"""SOCKS5 CONNECT 客户端（仅标准库），用作 ssh ProxyCommand。

用法: python socks5.py <proxy_host> <proxy_port> <dest_host> <dest_port>
通过本地 SOCKS5（如 ssh -D 建立的隧道）转发 stdio 到目标地址。
"""
import os
import socket
import sys
import threading


def main():
    proxy_host, proxy_port, dest_host, dest_port = (
        sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4]),
    )
    s = socket.create_connection((proxy_host, proxy_port))

    # 握手：无认证
    s.sendall(b"\x05\x01\x00")
    r = s.recv(2)
    if r[0:1] != b"\x05" or r[1:2] != b"\x00":
        sys.stderr.write("socks5 handshake failed\n")
        sys.exit(1)

    # CONNECT，目标用域名形式传给代理端解析
    d = dest_host.encode()
    addr = b"\x03" + bytes([len(d)]) + d + dest_port.to_bytes(2, "big")
    s.sendall(b"\x05\x01\x00" + addr)
    head = s.recv(4)
    if len(head) < 4 or head[1] != 0:
        sys.stderr.write(f"socks5 connect refused: {head!r}\n")
        sys.exit(1)
    atyp = head[3]
    if atyp == 1:
        s.recv(4 + 2)
    elif atyp == 3:
        n = s.recv(1)[0]
        s.recv(n + 2)
    elif atyp == 4:
        s.recv(16 + 2)

    def pump_stdin(sock):
        # os.read 短读立即返回，避免 Windows 管道等满缓冲导致死锁
        try:
            while True:
                data = os.read(0, 65536)
                if not data:
                    break
                sock.sendall(data)
        except Exception:
            pass
        try:
            sock.shutdown(socket.SHUT_WR)
        except Exception:
            pass

    def pump_stdout(sock):
        try:
            while True:
                data = sock.recv(65536)
                if not data:
                    break
                os.write(1, data)
        except Exception:
            pass

    threading.Thread(target=pump_stdin, args=(s,), daemon=True).start()
    out = threading.Thread(target=pump_stdout, args=(s,), daemon=True)
    out.start()
    out.join()


if __name__ == "__main__":
    main()
