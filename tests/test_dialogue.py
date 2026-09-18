import pytest
from tornado.web import HTTPError
from backend.dialogue import endpoint, answer, request_body, history, validate_question, language_models
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
