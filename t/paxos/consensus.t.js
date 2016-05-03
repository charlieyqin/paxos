require('proof')(16, prove)

function prove (assert) {
    var Legislator = require('../../legislator'),
        signal = require('signal')

    signal.subscribe('.bigeasy.paxos.invoke'.split('.'), function (id, method, vargs) {
         if (id == '0') {
            // console.log(JSON.stringify({ method: method, vargs: vargs }))
        }
    })

    function dump (legislator) {
        legislator.log.each(function (entry) { console.log(entry) })
    }

    var time = 0, gremlin

    var options = {
        Date: { now: function () { return time } },
        parliamentSize: 5,
        ping: 1,
        timeout: 2,
        retry: 5
    }

    var count = 0, util = require('util')

    assert(! new Legislator(time, '0').checkSchedule(time), 'empty schedule')
    var legislators = [ new Legislator(time, '0', options) ]
    legislators[0].bootstrap(time, '0')

    function send (legislator, failures) {
        failures || (failures = {})
        var sent = false
        var outbox = legislator.synchronize(time)
        if (outbox.length == 0) {
            var consensus = legislator.consensus(time)
            if (consensus) {
                sent = true
                outbox = [ consensus ]
            }
        }
        while (outbox.length != 0) {
            sent = true
            var send = outbox.shift(), responses = {}
            send.route.forEach(function (id) {
                var legislator = legislators[id]
                if (failures[id] != 'request') {
                    responses[id] = legislator.receive(time, send, send.messages)
                }
                if (failures[id] == 'response') {
                    delete responses[id]
                }
            })
            legislator.sent(time, send, responses)
        }
        return sent
    }

    function tick (failures) {
        var ticked = true
        while (ticked) {
            ticked = false
            legislators.forEach(function (legislator) {
                while (send(legislator, failures)) {
                    ticked = true
                }
            })
        }
    }

    tick()

    assert(legislators[0].government, {
        majority: [ '0' ],
        minority: [],
        constituents: [],
        promise: '1/0'
    }, 'bootstrap')

    legislators.push(new Legislator(time, '1', options))

    assert(legislators[0].naturalize(time, '1', legislators[1].cookie, '1').posted, 'naturalize')
    tick()

    assert(legislators[0].government, {
        majority: [ '0' ],
        minority: [],
        naturalize: { id: '1', location: '1', cookie: 0 },
        constituents: [ '1' ],
        promise: '2/0'
    }, 'leader and constituent pair')

    assert(legislators[1].log.size, 2, 'synchronized')

    legislators.push(new Legislator(0, '2', options))
    legislators[0].post(time, { type: 'enqueue', value: 1 })
    legislators[0].naturalize(time, '2', legislators[2].cookie, '2')

    tick()

    assert(legislators[0].government, {
        majority: [ '0', '1' ],
        minority: [ '2' ],
        constituents: [],
        promise: '4/0'
    }, 'three member parliament')

    assert(legislators[2].log.size, 4, 'synchronized')

    legislators[0]._whenCollapse()
    legislators[1]._whenCollapse()

    assert(legislators[1].post(time, {}).leader, '0', 'post not leader')
    assert(!legislators[0].post(time, {}).posted, 'post collapsed')

    tick()

    assert(legislators[0].government, {
        majority: [ '0', '1' ],
        minority: [ '2' ],
        constituents: [],
        promise: '5/0'
    }, 'recover from collapse')

    legislators[0]._peers[1].timeout = 1

    legislators[0]._whenPulse(time)

    tick()

    assert(legislators[0]._peers[1].timeout, 0, 'liveness pulse')

    legislators[1]._whenPing(time)

    assert(legislators[1]._peers[2].timeout, 1, 'liveness ping timeout set')

    tick()

    assert(legislators[1]._peers[2].timeout, 0, 'liveness ping resolved')

    delete legislators[1]._peers[2]

    legislators[1]._whenPing(time)

    tick()

    assert(legislators[1]._peers[2].timeout, 0, 'liveness ping materialized')

    legislators.push(new Legislator(time, '3', options))
    legislators[0].naturalize(time, '3', legislators[3].cookie, '3')
    legislators.push(new Legislator(time, '4', options))
    legislators[0].naturalize(time, '4', legislators[4].cookie, '4')
    legislators[0].post(time, { type: 'enqueue', value: 2 })

    while (send(legislators[0]));

    assert(legislators[3].log.size, 1, 'log before naturalization')

    tick()

    assert(legislators[3].log.size, 4, 'log after naturalization')

    legislators[0].post(time, { type: 'enqueue', value: 2 })
    legislators[0].post(time, { type: 'enqueue', value: 3 })

    tick()
}
