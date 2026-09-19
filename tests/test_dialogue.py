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
    body = request_body('gpt-6-astra', [{'role': 'user', 'content': 'run tests'}], '/v1/responses', True,
                        allowed_paths=['/Users/test/Sites', '/tmp/project'])
    assert body['tools'][0]['name'] == 'run_command'
    assert set(body['tools'][0]['parameters']['required']) == {'argv', 'cwd', 'reason'}
    assert '/Users/test/Sites' in body['tools'][0]['description']
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


def test_failed_turns_are_sent_as_context():
    turns = [{'question': 'q', 'answer': 'a', 'status': 'completed'}, {'question': 'retry', 'status': 'failed'}]
    assert history(turns) == [{'role': 'user', 'content': 'q'}, {'role': 'assistant', 'content': 'a'}, {'role': 'user', 'content': 'retry'}, {'role': 'assistant', 'content': '本轮未完成，未生成回答。'}]


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


def test_agent_allowed_paths_are_absolute_and_bounded():
    from backend.dialogue import allowed_paths
    assert allowed_paths(['/a', '/a', '/b']) == ['/a', '/b']
    for value in ['bad', ['relative'], ['/x'] * 33, [1]]:
        with pytest.raises(HTTPError): allowed_paths(value)


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
    agent = submission_stats(raw, prepared, 'gpt-6-astra', '/v1/responses', True)
    assert agent['request_bytes'] == len(json.dumps(request_body('gpt-6-astra', prepared, '/v1/responses', True),
                                                  ensure_ascii=False, separators=(',', ':')).encode())
    assert agent['request_bytes'] > result['request_bytes']


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


def test_tool_continuation_keeps_full_context_without_server_response_id():
    from backend.dialogue import tool_continuation
    context = [{'role': 'user', 'content': 'check'},
               {'type': 'reasoning', 'encrypted_content': 'opaque'},
               {'type': 'function_call', 'call_id': 'call_1', 'name': 'run_command', 'arguments': '{}'}]
    turn = {'agent_context': context, 'provider_response_id': 'expired'}
    messages, previous = tool_continuation(turn, {'call_id': 'call_1'}, 'done')
    assert previous is None
    assert messages[:-1] == context
    assert len(context) == 3
    assert messages[-1]['call_id'] == 'call_1'
    body = request_body('gpt-6-astra', messages, '/v1/responses', True, previous)
    assert 'previous_response_id' not in body
    assert body['parallel_tool_calls'] is False
    assert body['include'] == ['reasoning.encrypted_content']


def test_failed_command_results_survive_followup():
    messages = history([{'question': 'research', 'status': 'failed', 'error': 'reason 缺失',
                         'tool_calls': [{'argv': ['mkdir', '资料'], 'cwd': '/tmp', 'status': 'completed',
                                         'result': {'exit_code': 0, 'stdout': 'done'}}]}])
    assert 'mkdir' in messages[1]['content']
    assert 'done' in messages[1]['content']
    assert 'reason 缺失' in messages[1]['content']
    assert history([{'question': 'pending', 'status': 'running'}]) == []


def test_command_error_identifies_field_without_echoing_content():
    with pytest.raises(ProviderError, match=r'argv\[1\].*8193'):
        function_call({'output': [{'type': 'function_call', 'name': 'run_command',
                                  'arguments': __import__('json').dumps({'argv': ['python', 'x'*8193], 'cwd': '/tmp', 'reason': 'test'})}]})
