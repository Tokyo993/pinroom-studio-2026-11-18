import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boardName,addToBoard,removeFromBoard} from '../dist/storage.js';
const library=()=>({boards:[{id:'a',name:'A',pins:[]},{id:'b',name:'B',pins:[]}],pins:{}});
test('board names trim whitespace and reject empty or oversized input',()=>{assert.equal(boardName('  My   ideas  '),'My ideas');assert.throws(()=>boardName(' '));assert.throws(()=>boardName('x'.repeat(61)));});
test('saving is idempotent and leaves original state unchanged',()=>{const before=library();const after=addToBoard(addToBoard(before,'a',{id:'1',title:'Test'}),'a',{id:'1',title:'Test'});assert.deepEqual(after.boards[0].pins,['1']);assert.deepEqual(before,library());});
test('removing keeps an image used on another board, then releases it',()=>{let state=addToBoard(library(),'a',{id:'1'});state=addToBoard(state,'b',{id:'1'});state=removeFromBoard(state,'a','1');assert.ok(state.pins['1']);state=removeFromBoard(state,'b','1');assert.equal(state.pins['1'],undefined);});
test('missing board cannot mutate library',()=>{assert.throws(()=>addToBoard(library(),'missing',{id:'1'}));assert.throws(()=>removeFromBoard(library(),'missing','1'));});
