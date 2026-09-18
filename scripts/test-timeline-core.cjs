const assert=require('node:assert/strict');
const {layers,activeClip}=require('../backend/web/timeline.js');
const clips=[{id:'a',start:0,duration:10},{id:'b',start:7,duration:10},{id:'c',start:8,duration:2},{id:'d',start:17,duration:2}];
const {rows,max}=layers(clips);
assert.equal(rows.get('a'),0);assert.equal(rows.get('b'),1);assert.equal(rows.get('c'),2);
assert.equal(rows.get('d'),0);assert.equal(max,2);
assert.equal(activeClip({clips},9).id,'c');assert.equal(activeClip({clips},10).id,'b');
assert.equal(layers([clips[1],clips[0]]).rows.get('a'),1);
console.log('Overlap rows: touching endpoints, triple overlap, priority and order verified.');
