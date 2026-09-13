import json

from tornado.testing import AsyncHTTPTestCase
from tornado.web import Application, HTTPError

from backend.server import BaseHandler


class InvalidSizeHandler(BaseHandler):
    def get(self):
        raise HTTPError(400, reason='宽度需为 256–1536 px 的整数')


class TestLocalizedErrors(AsyncHTTPTestCase):
    def get_app(self):
        return Application([(r'/', InvalidSizeHandler)])

    def test_chinese_error_survives_http_reason_sanitization(self):
        response = self.fetch('/')
        assert response.code == 400
        assert response.reason == 'Bad Request'
        assert json.loads(response.body)['error'] == '宽度需为 256–1536 px 的整数'
