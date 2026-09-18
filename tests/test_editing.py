import copy
import uuid
from test_sync import client_for
from test_integration import service


def test_exclusive_card_and_timeline_leases_and_save_guard(service):
    with client_for(service) as a, client_for(service) as b:
        a.headers['X-Director-Client'] = uuid.uuid4().hex
        b.headers['X-Director-Client'] = uuid.uuid4().hex
        card = {'id': uuid.uuid4().hex, 'type': 'image', 'mode': 'text', 'x': 0, 'y': 0, 'w': 500, 'h': 600, 'drafts': {}}
        p = a.post('/api/projects', json={'title': 'Live editing', 'canvas': {'viewport': {'x': 0, 'y': 0, 'zoom': 1}, 'cards': [card]}}).json()
        url = '/api/projects/' + p['block_id']; lock = url + '/editing'; key = 'card:' + card['id']
        response = a.post(lock, json={'action': 'claim', 'resource': key})
        assert response.status_code == 200, response.text
        assert response.json()['leases'][key]['login'] == 'director'
        assert b.post(lock, json={'action': 'claim', 'resource': key}).status_code == 423
        assert b.get(lock).json()['leases'][key]['client'] == a.headers['X-Director-Client']
        changed = copy.deepcopy(p['body']); changed['canvas']['cards'][0]['title'] = 'Locked edit'
        assert b.post(url, json=changed).status_code == 423
        assert a.post(url, json=changed).status_code == 200
        assert b.post(lock, json={'action': 'release', 'resource': key}).status_code == 200
        assert key in b.get(lock).json()['leases']  # A different tab cannot release it.
        assert a.post(lock, json={'action': 'release', 'resource': key}).status_code == 200
        assert b.post(lock, json={'action': 'claim', 'resource': key}).status_code == 200
        assert a.post(lock, json={'action': 'claim', 'resource': 'timeline:main'}).status_code == 200
        body = b.get(url).json()['body']; body['canvas']['timeline'] = {'version': 1, 'start': 1, 'zoom': 60, 'snap': True, 'clips': [], 'subtitles': []}
        assert b.post(url, json=body).status_code == 423
        assert a.post(lock, json={'action': 'claim', 'resource': 'card:' + uuid.uuid4().hex}).status_code == 400
        assert a.get('/api/projects/' + uuid.uuid4().hex + '/editing').status_code == 404
