"""Test single-instance socket connection and activation."""

import pytest
import os
from PySide6.QtWidgets import QApplication
from PySide6.QtNetwork import QLocalServer, QLocalSocket


@pytest.fixture(scope="session")
def qapp():
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    app = QApplication.instance()
    if app is None:
        app = QApplication([])
    return app


def test_single_instance_ipc(qapp):
    pipe_name = "FunPayHotkeys_Test_Pipe"
    QLocalServer.removeServer(pipe_name)

    server = QLocalServer()
    assert server.listen(pipe_name) is True

    connection_received = []

    def on_connection():
        client = server.nextPendingConnection()
        if client:
            client.waitForReadyRead(500)
            msg = client.readAll().data().decode("utf-8")
            connection_received.append(msg.strip())
            client.disconnectFromServer()

    server.newConnection.connect(on_connection)

    # Second instance simulation
    client_socket = QLocalSocket()
    client_socket.connectToServer(pipe_name)
    assert client_socket.waitForConnected(1000) is True

    client_socket.write(b"ACTIVATE\n")
    client_socket.waitForBytesWritten(1000)
    qapp.processEvents()

    assert "ACTIVATE" in connection_received
    client_socket.disconnectFromServer()
    server.close()
