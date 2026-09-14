import pytest
from tornado.web import HTTPError
from backend.comments import review_data


@pytest.mark.parametrize('value,media',[
    ({'kind':'video','start':-1,'end':3},'video'),
    ({'kind':'video','start':4,'end':3},'video'),
    ({'kind':'video','start':3,'end':3},'video'),
    ({'kind':'video','start':True,'end':3},'video'),
    ({'kind':'video','start':0,'end':float('inf')},'video'),
    ({'kind':'video','start':float('nan'),'end':3},'video'),
    ({'kind':'video','start':.0001,'end':.0002},'video'),
    ({'kind':'video','start':0,'end':2},'image'),
    ({'kind':'image','shapes':[{'type':'script'}]},'image'),
    ({'kind':'image','shapes':[{'type':'rect','x':.9,'y':0,'w':.2,'h':.1}]},'image'),
    ({'kind':'image','shapes':[{'type':'rect','x':0,'y':0,'w':.2,'h':.1,'color':'red" onload="evil'}]},'image'),
    ({'kind':'image','shapes':[{'type':'path','points':[[0,0],[1,2]]}]},'image'),
    ({'kind':'image','shapes':[{'type':'path','points':[[0,0]]}]},'image'),
    ({'kind':'image','shapes':[{'type':'rect','x':0,'y':0,'w':.2,'h':.1}]*51},'image'),
])
def test_invalid_review_metadata_rejected(value,media):
    with pytest.raises(HTTPError):review_data(value,media)


def test_review_coordinate_roundtrip_and_whitelist():
    r=review_data({'kind':'image','svg':'<script/>','shapes':[
        {'type':'rect','x':.1,'y':.2,'w':.3,'h':.4,'onload':'evil'},
        {'type':'path','points':[[0,0],[.5,.5],[1,1]],'color':'#00FF00','width':2}]},'image')
    assert 'svg' not in r and 'onload' not in r['shapes'][0]
    assert r['shapes'][0]['x']==.1 and r['shapes'][1]['points'][-1]==[1,1]
    assert review_data(r,'image')==r
    assert review_data({'kind':'video','start':12.125,'end':15.75},'video')=={'kind':'video','start':12.125,'end':15.75}
