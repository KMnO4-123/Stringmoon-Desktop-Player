import test from 'node:test'
import assert from 'node:assert/strict'
import { createStartupSequence, startupLanding } from '../src/renderer/src/components/startup/startupSequence.ts'

function clock() {
  let now = 0, nextId = 0
  const tasks = new Map()
  return {
    schedule(callback, delay) {
      const id = ++nextId
      tasks.set(id, { at: now + delay, callback })
      return () => tasks.delete(id)
    },
    advance(ms) {
      const until = now + ms
      for (;;) {
        const due = [...tasks].filter(([,task]) => task.at <= until).sort((a,b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [id,task] = due
        now = task.at
        tasks.delete(id)
        task.callback()
      }
      now = until
    },
    get pending() { return tasks.size }
  }
}

function fixture(reducedMotion = false) {
  const time = clock(), exits = [], completed = []
  const sequence = createStartupSequence({
    reducedMotion, schedule: time.schedule,
    onExit: (reason,duration) => exits.push({reason,duration}),
    onComplete: () => completed.push(true)
  })
  return {time,exits,completed,sequence}
}

test('ready startup preserves the approved 3.6 second sequence then releases all work', () => {
  const f = fixture()
  f.sequence.ready()
  f.time.advance(2319)
  assert.equal(f.sequence.phase,'entering')
  f.time.advance(1)
  assert.deepEqual(f.exits,[{reason:'ready',duration:1280}])
  f.time.advance(1280)
  assert.equal(f.sequence.phase,'complete')
  assert.equal(f.completed.length,1)
  assert.equal(f.time.pending,0)
})

test('a slow library holds the identity once, then continues when ready without polling', () => {
  const f = fixture()
  f.time.advance(3000)
  assert.equal(f.sequence.phase,'holding')
  assert.equal(f.time.pending,1)
  assert.equal(f.exits.length,0)
  f.sequence.ready()
  f.sequence.ready()
  assert.equal(f.exits.length,1)
  f.time.advance(1280)
  assert.equal(f.completed.length,1)
  assert.equal(f.time.pending,0)
})

test('holding notifies the view once so delayed readiness has a visible status', () => {
  const time=clock(), held=[]
  const sequence=createStartupSequence({reducedMotion:false,schedule:time.schedule,onHold:()=>held.push(true),onExit:()=>{},onComplete:()=>{}})
  time.advance(2320)
  assert.equal(held.length,1)
  sequence.ready()
  time.advance(10000)
  assert.equal(held.length,1)
})

test('a stalled or failed bootstrap cannot trap the user behind startup', () => {
  const f = fixture()
  f.time.advance(5000)
  assert.deepEqual(f.exits,[{reason:'deadline',duration:1280}])
  f.time.advance(1280)
  f.sequence.ready()
  assert.equal(f.completed.length,1)
  assert.equal(f.time.pending,0)
})

test('skip is immediate to begin, settles once, and ignores late readiness', () => {
  const f = fixture()
  f.time.advance(100)
  f.sequence.skip()
  f.sequence.skip()
  f.sequence.ready()
  assert.deepEqual(f.exits,[{reason:'skip',duration:140}])
  f.time.advance(140)
  f.time.advance(10000)
  assert.equal(f.completed.length,1)
  assert.equal(f.time.pending,0)
})

test('skip also interrupts a natural exit instead of waiting for the long dissolve', () => {
  const f = fixture()
  f.sequence.ready()
  f.time.advance(2400)
  f.sequence.skip()
  assert.equal(f.exits.at(-1).reason,'skip')
  f.time.advance(140)
  assert.equal(f.completed.length,1)
  assert.equal(f.time.pending,0)
})

test('reduced motion settles in 650 ms when ready', () => {
  const f = fixture(true)
  f.sequence.ready()
  f.time.advance(650)
  assert.deepEqual(f.exits,[{reason:'ready',duration:400}])
  assert.equal(f.completed.length,1)
  assert.equal(f.time.pending,0)
})

test('hiding completes immediately while unmounting disposes without a callback', () => {
  const hidden = fixture()
  hidden.sequence.finish()
  hidden.sequence.finish()
  hidden.time.advance(10000)
  assert.equal(hidden.completed.length,1)
  assert.equal(hidden.time.pending,0)
  const unmounted = fixture()
  unmounted.sequence.dispose()
  unmounted.sequence.ready()
  unmounted.sequence.skip()
  unmounted.time.advance(10000)
  assert.equal(unmounted.completed.length,0)
  assert.equal(unmounted.exits.length,0)
  assert.equal(unmounted.time.pending,0)
})

test('disc landing uses live bounds and uniform scaling at both supported window sizes', () => {
  for (const viewport of [{width:1280,height:800},{width:900,height:600}]) {
    const record = {left:300,top:190,width:180,height:240}
    const landing = startupLanding(viewport,record)
    assert.ok(landing.sceneScale > 0)
    assert.equal(landing.sceneLeft + landing.sceneScale * (640 + landing.x),390)
    assert.equal(landing.sceneTop + landing.sceneScale * (305 + landing.y),310)
    assert.ok(landing.scale > 0 && landing.scale < 1)
  }
  assert.equal(startupLanding({width:0,height:0},null).scale,1)
})
