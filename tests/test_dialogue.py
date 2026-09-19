import pytest
from tornado.web import HTTPError
from backend.dialogue import endpoint, answer, request_body, history, validate_question, language_models, function_call
from backend.inference import ProviderError


def test_language_inventory_excludes_media_and_unknown_capabilities():
    items = [{'id': 'text', 'type': 'llm'}, {'id': 'image', 'type': 'image'}, {'id': 'unknown', 'type': None}]
    assert language_models(items) == items[:1]


def test_endpoint_and_payload_never_send_incompatible_tools():
    messages = [{'role': 'user', 'content': 'hello'}]
    assert endpoint('gpt-6-astra') == '/v1/responses'
    assert endpoint('other') == '/v1/chat/completions'
    assert endpoint('other', 'responses') == '/v1/responses'
    for path in ['/v1/responses', '/v1/chat/completions']:
        body = request_body('gpt-6-astra', messages, path)
        assert not {'tools', 'reasoning_effort', 'reasoning'} & body.keys()
    with pytest.raises(HTTPError): endpoint('gpt-6-astra', 'invalid')


def test_agent_payload_uses_responses_function_tool():
    body = request_body('gpt-6-astra', [{'role': 'user', 'content': 'run tests'}], '/v1/responses', True)
    assert body['tools'][0]['name'] == 'run_command'
    assert body['tool_choice'] == 'auto'
    continued = request_body('gpt-6-astra', [{'type': 'function_call_output', 'call_id': 'call_1', 'output': '{}'}],
                             '/v1/responses', True, 'resp_1')
    assert continued['previous_response_id'] == 'resp_1'
    with pytest.raises(HTTPError): request_body('gpt-6-astra', [], '/v1/chat/completions', True)


def test_agent_function_call_is_validated():
    result = {'output': [{'type': 'function_call', 'name': 'run_command', 'call_id': 'call_1',
                          'arguments': '{"argv":["python","-V"],"cwd":".","reason":"Check Python"}'}]}
    call = function_call(result)
    assert call['argv'] == ['python', '-V']
    assert call['status'] == 'approval_required'
    with pytest.raises(ProviderError): function_call({'output': [{**result['output'][0], 'arguments': '{bad'}]})


def test_responses_extracts_only_assistant_output_not_reasoning():
    result = {'status': 'completed', 'output': [
        {'type': 'reasoning', 'summary': [{'text': 'private'}]},
        {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Hello'}, {'type': 'output_text', 'text': ' world'}]},
    ]}
    assert answer(result, '/v1/responses') == 'Hello world'
    result['status'] = 'incomplete'
    with pytest.raises(ProviderError): answer(result, '/v1/responses')


def test_failed_turns_are_not_sent_as_context():
    turns = [{'question': 'q', 'answer': 'a', 'status': 'completed'}, {'question': 'retry', 'status': 'failed'}]
    assert history(turns) == [{'role': 'user', 'content': 'q'}, {'role': 'assistant', 'content': 'a'}]


@pytest.mark.parametrize('data', [{'question': ''}, {'question': 'q', 'request_id': 'bad'}, {'question': 'q'*20001, 'request_id': 'a'*32}])
def test_invalid_question_is_rejected(data):
    with pytest.raises(HTTPError): validate_question(data)


def test_dialogue_options_boundaries_and_types():
    from backend.dialogue import dialogue_options
    assert dialogue_options({}) == {'context_turns': 20, 'pack_size': 25}
    assert dialogue_options({'context_turns': 0, 'pack_size': 1}) == {'context_turns': 0, 'pack_size': 1}
    assert dialogue_options({'context_turns': 100, 'pack_size': 100}) == {'context_turns': 100, 'pack_size': 100}
    for values in [{'context_turns': -1}, {'context_turns': 101}, {'pack_size': 0}, {'pack_size': 101}, {'pack_size': True}, {'context_turns': '2'}, {'pack_size': 1.5}]:
        with pytest.raises(HTTPError): dialogue_options(values)


def test_submission_stats_reports_exact_request_size_and_content_totals():
    import json
    from backend.dialogue import submission_stats, request_body
    raw = [{'role': 'user', 'content': '旧问题'}, {'role': 'assistant', 'content': '旧回答'},
           {'role': 'user', 'content': '新问题', 'attachments': [{'size': 123}, {'size': 456}]}]
    prepared = [{'role': item['role'], 'content': item['content']} for item in raw]
    result = submission_stats(raw, prepared, 'fixture-chat', '/v1/chat/completions')
    assert result == {'history_turns': 1, 'messages': 3, 'text_chars': 9, 'attachments': 2,
                      'attachment_bytes': 579,
                      'request_bytes': len(json.dumps(request_body('fixture-chat', prepared, '/v1/chat/completions'),
                                                      ensure_ascii=False, separators=(',', ':')).encode())}


def test_dialogue_names_and_metadata_validation():
    from backend.dialogue import category_name, conversation_metadata
    assert category_name('  研究  ') == '研究'
    assert conversation_metadata({'title': ' 标题 ', 'description': ' 说明 ', 'category_id': None,
                                  'archived': True}) == {
        'title': '标题', 'description': '说明', 'category_id': None, 'archived': True}
    for value in ['', 'x' * 61, None]:
        with pytest.raises(HTTPError): category_name(value)
    for value in [
        {'title': ''}, {'title': 'x' * 121}, {'title': 'ok', 'description': 'x' * 1001},
        {'title': 'ok', 'category_id': 'bad'}, {'title': 'ok', 'archived': 1},
    ]:
        with pytest.raises(HTTPError): conversation_metadata(value)
