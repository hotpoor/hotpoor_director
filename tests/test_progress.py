from backend.progress import ProgressTracker


def test_progress_is_scoped_and_resets_between_nodes():
    tracker = ProgressTracker()
    tracker.update('alice', {'type':'progress','data':{'prompt_id':'p','node':'8','value':3,'max':8}})
    assert tracker.values[('alice','p')]['value'] == 3
    assert ('bob','p') not in tracker.values
    tracker.update('alice', {'type':'executing','data':{'prompt_id':'p','node':'9'}})
    assert tracker.values[('alice','p')] == {'phase':'running','node':'9'}
    tracker.update('alice', {'type':'execution_success','data':{'prompt_id':'p'}})
    assert tracker.values[('alice','p')]['phase'] == 'finishing'


def test_invalid_progress_and_bounded_cache():
    tracker = ProgressTracker()
    tracker.update('a', {'type':'progress','data':{'prompt_id':'p','value':1,'max':0}})
    assert not tracker.values
    for i in range(1005):
        tracker.update('a', {'type':'execution_start','data':{'prompt_id':str(i)}})
    assert len(tracker.values) == 1000
    assert ('a','0') not in tracker.values
