import copy
import uuid
import pytest
from backend.timeline import validate_timeline
from backend import sync_protocol as protocol
from test_sync import snapshot, client_for
from test_integration import service


def timeline():
    clip = {'id': uuid.uuid4().hex, 'start': 2, 'duration': 5, 'in': 1, 'source_duration': 8, 'title': '采访开场', 'source_name': '书房采访 · 结果 1',
            'media': {'source': 'url', 'url': 'https://example.com/video.mp4', 'mime': 'video/mp4', 'name': 'shot'}}
    return {'version': 1, 'start': 1, 'zoom': 60, 'snap': True, 'clips': [clip], 'subtitles': [
        {'id': uuid.uuid4().hex, 'start': 1, 'duration': 2, 'text': '字幕', 'mode': 'follow', 'clip_id': clip['id']}]}


def test_timeline_sync_copy_and_layer_order():
    s = snapshot(); t = timeline(); s['records'][s['project_id']]['canvas']['timeline'] = t
    result, mapping = protocol.fresh_copy(s, uuid.uuid4().hex)
    new = result['records'][result['project_id']]['canvas']['timeline']
    assert new['subtitles'][0]['clip_id'] == new['clips'][0]['id'] == mapping[t['clips'][0]['id']]
    assert new['subtitles'][0]['text'] == '字幕'
    assert new['clips'][0]['title'] == '采访开场'
    assert new['clips'][0]['source_name'] == '书房采访 · 结果 1'
    before = copy.deepcopy(t); t['clips'].append({**t['clips'][0], 'id': uuid.uuid4().hex})
    changed = copy.deepcopy(t); changed['clips'].reverse()
    assert protocol.diff(t, changed, '/canvas/timeline')[0]['path'].endswith('/clips/order')


@pytest.mark.parametrize('field,value', [('start', -1), ('start', float('nan')), ('duration', 0), ('duration', 9), ('in', -1)])
def test_invalid_clip_bounds(field, value):
    t = timeline(); t['clips'][0][field] = value
    with pytest.raises(ValueError): validate_timeline(t)


def test_follow_subtitle_requires_valid_parent_and_bounds():
    t = timeline(); t['subtitles'][0]['clip_id'] = uuid.uuid4().hex
    with pytest.raises(ValueError): validate_timeline(t)
    t = timeline(); t['subtitles'][0]['duration'] = 5
    with pytest.raises(ValueError): validate_timeline(t)


def test_project_round_trip_and_reject_unauthorized_media(service):
    with client_for(service) as c:
        project = c.post('/api/projects', json={'title': 'Timeline'}).json()
        body = project['body']; body['canvas']['timeline'] = timeline()
        r = c.post('/api/projects/' + project['block_id'], json=body)
        assert r.status_code == 200, r.text
        body = r.json()['body']
        assert c.get('/api/projects/' + project['block_id']).json()['body']['canvas']['timeline']['subtitles'][0]['mode'] == 'follow'
        body['canvas']['timeline']['clips'][0]['media'] = {'source': 'asset', 'id': uuid.uuid4().hex}
        assert c.post('/api/projects/' + project['block_id'], json=body).status_code == 404


def test_multiple_timelines_copy_and_validation():
    from backend.timeline import validate_timelines
    s = snapshot(); canvas = s['records'][s['project_id']]['canvas']
    canvas['timeline'] = timeline()
    canvas['timelines'] = [dict(timeline(), id=uuid.uuid4().hex, name='另一版剪辑')]
    validate_timelines(canvas)
    result, mapping = protocol.fresh_copy(s, uuid.uuid4().hex)
    extra = result['records'][result['project_id']]['canvas']['timelines'][0]
    assert extra['id'] == mapping[canvas['timelines'][0]['id']]
    assert extra['subtitles'][0]['clip_id'] == extra['clips'][0]['id']
    canvas['timelines'][0]['clips'][0]['id'] = canvas['timeline']['clips'][0]['id']
    canvas['timelines'][0]['subtitles'][0]['clip_id'] = canvas['timeline']['clips'][0]['id']
    with pytest.raises(ValueError, match='重复'): validate_timelines(canvas)


def test_extra_timeline_media_authorization(service):
    with client_for(service) as c:
        p = c.post('/api/projects', json={'title': '多轴'}).json()
        body=p['body']; body['canvas']['timelines']=[dict(timeline(), id=uuid.uuid4().hex)]
        response=c.post('/api/projects/'+p['block_id'],json=body)
        assert response.status_code==200,response.text
        body=response.json()['body']
        body['canvas']['timelines'][0]['clips'][0]['media']={'source':'asset','id':uuid.uuid4().hex}
        assert c.post('/api/projects/'+p['block_id'],json=body).status_code==404
