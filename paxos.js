// Common utilities.
var assert = require('assert')

// Return the first not null-like value.
var coalesce = require('extant')

// Ever increasing serial value with no maximum value.
var Monotonic = require('monotonic').asString

// A timer with named, cancelable events.
var Scheduler = require('happenstance').Scheduler

// An evented message queue used for the atomic log.
var Procession = require('procession')
var Window = require('procession/window')

// A sorted index into the atomic log. TODO Must it be a tree?
var Indexer = require('procession/indexer')

// Logging conduit.
var logger = require('prolific.logger').createLogger('paxos')

// The participants in the Paxos strategy.
var Assembly = require('./assembly')
var Proposer = require('./proposer')
var Acceptor = require('./acceptor')

// The participants in the two-phase commit strategy.
var Shaper = require('./shaper')
var Writer = require('./writer')
var Recorder = require('./recorder')

var Pinger = require('./pinger')
var Relay = require('./relay')

var departure = require('departure')
var constituency = require('./constituency')

// ### Constructor
function Paxos (now, republic, id, options) {
    // Uniquely identify ourselves relative to the other participants.
    this.id = String(id)

    // Use the create time as a cookie to identify this instance of this id.
    this.cookie = now

    // A republic identifies a paritcular instance of the Paxos algorithm.
    this.republic = republic

    // Maybe start out naturalized if no futher updates necessary.
    this.naturalized = !! options.naturalized

    // Maximum size of a parliament. The government will grow to this size.
    this.parliamentSize = coalesce(options.parliamentSize, 5)

    // The atomic log is a linked list. When head of the list is advanced the
    // entries in the list become unreachable and can be collected by the
    // garbage collector. We advance the head of the list when we are certain
    // that all participants have received a copy of the entry and added it to
    // their logs. Outstanding user iterators prevent garbage collection.
    this.log = new Window
    this.log.addListener(this.indexer = new Indexer(function (left, right) {
        assert(left && right)
        assert(left.body && right.body)
        return Monotonic.compare(left.body.promise, right.body.promise)
    }))

    // Implements a calendar for events that we can check during runtime or
    // ignore during debugging playback.
    this.scheduler = new Scheduler

    // Initial government. A null government.
    this.government = {
        promise: '0/0',
        minority: [],
        majority: [],
        constituents: [],
        properties: {},
        immigrated: { id: {}, promise: {} }
    }

    // Last promise issued.
    this._promised = null

    // Ping is the freqency of keep alive pings.
    this.ping = coalesce(options.ping, 1000)

    // Timeout when that reached marks a citizen for exile.
    this.timeout = coalesce(options.timeout, 5000)

    // The citizens that this citizen updates with new log entries.
    this.constituency = []

    // Entire population.
    this.citizens = []

    // The least committed value across the entire island.
    this.minimum = '0/0'

    // Network message queue.
    this.outbox = new Procession

    // Collection accounting information. See [Pinger](./pinger.js.html).
    this._pinger = new Pinger(null, this.timeout)

    // Push the null government onto the atomic log.
    this.log.push({
        module: 'paxos',
        method: 'government',
        promise: '0/0',
        body: this.government,
        previous: null
    })

    this._writer = new Writer(this, '1/0')
    this._recorder = new Recorder(this, this.log.head.body)
    this._shaper = new Shaper(this.parliamentSize, this.government)

    // Used for our pseudo-random number generator to vary retry times.
    this._seed = 2147483647

    // Track ping information that has propigated back.
    this._receipts = {}
}

// ### Government

// Constructs a new government and unshifts it onto the head of the proposal
// queue. During two-phase commit, new governments jump to the line. All the
// user messages are given new promises whose values are greater than the value
// of the government's promise.
//
// During a collapse when we are running Paxos, the new government is the only
// message and all user messages are dropped.
//
// There is only ever supposed to be one new government in process or in the
// list of proposals. Many decisions about the new goverment are based on the
// current government and the current health of the island, so queuing up a
// bunch of governments would at the very least require that we double check
// that they are still valid.
//
// Basically, we have new governments queued elsewhere. Actually, we have
// network status queued elsewhere and new governments are proposed after the
// current new government is established based on that reachabilit data.

//
Paxos.prototype.newGovernment = function (now, quorum, government) {
    // Mark the shaper as complete. We won't get a new government proposal until
    // we get a new shaper.
    this._shaper.decided = true

    // Increment the government part of the promise.
    var promise = Monotonic.increment(this.government.promise, 0)

    // The government's constituents are our current population less the members
    // of the government itself.
    government.constituents = Object.keys(this.government.properties)
        .sort()
        .filter(function (citizen) {
            return !~government.majority.indexOf(citizen)
                && !~government.minority.indexOf(citizen)
        })

    // If we are doing a two-phase commit, gemap the proposals so that they have
    // a promise value in the new government.
    var remapped = government.promise = promise, map = null
    if (!this._writer.collapsed) {
        map = {}
        this._writer.proposals = this._writer.proposals.splice(0, this._writer.proposals.length).map(function (proposal) {
            proposal.was = proposal.promise
            proposal.route = government.majority
            proposal.promise = remapped = Monotonic.increment(remapped, 1)
            map[proposal.was] = proposal.promise
            return proposal
        })
    }
    this._promised = remapped

    // Copy the properties and immigration id to promise map.
    var properties = JSON.parse(JSON.stringify(this.government.properties))
    var immigrated = JSON.parse(JSON.stringify(this.government.immigrated))

    // Add the new denizen to the governments structures during immigraiton.
    // Remove the denizen from the governments structures during exile.
    if (government.immigrate) {
        var immigrate = government.immigrate
        properties[immigrate.id] = JSON.parse(JSON.stringify(government.immigrate.properties))
        government.constituents.push(immigrate.id)
        immigrated.promise[immigrate.id] = promise
        immigrated.id[promise] = immigrate.id
    } else if (government.exile) {
        var exile = government.exile
        exile.promise = immigrated.promise[exile.id]
        exile.properties = properties[exile.id]
        delete immigrated.promise[exile.id]
        delete immigrated.id[exile.promise]
        delete properties[exile.id]
        government.constituents.splice(government.constituents.indexOf(exile.id), 1)
    }

    government.map = map
    government.immigrated = immigrated
    government.properties = properties

    assert(this._writer.proposals.length == 0 || !Monotonic.isBoundary(this._writer.proposals[0].promise, 0))

    this._writer.unshift({ promise: promise, quorum: quorum, body: government })
    this._writer.nudge()
}

// ### Bootstrap

// Initialize the citizen with a government where it is the dictator.

//
Paxos.prototype.bootstrap = function (now, properties) {
    // Update current state as if we're already leader.
    this.naturalize()

    var government = {
        promise: '1/0',
        majority: [ this.id ],
        minority: [],
        constituents: [],
        map: {},
        immigrate: { id: '0', properties: properties, cookie: 0 },
        properties: {},
        immigrated: { promise: {}, id: {} }
    }

    government.properties[this.id] = properties
    government.immigrated.promise[this.id] = '1/0'
    government.immigrated.id['1/0'] = this.id

    this._promised = '1/0'

    this._shaper.immigrate({ id: this.id, cookie: 0 })

    this._commit(now, { promise: '1/0', body: government, previous: '0/0' }, '0/0')
}

// ### Enqueue and Immigrate

// TODO Is all this checking necessary? Is it necessary to return the island id
// and leader? This imagines that the client is going to do the retry, but in
// reality we often have the cluster performt the retry. The client needs to
// talk to a server that can be discovered, it can't use the Paxos algorithm for
// address resolution. From the suggested logic, it will only have a single
// address, and maybe be told of an actual leader. What happens when that
// address is lost? Don't see where returning `republic` and leader helps at
// all. It is enough to say you failed, backoff and try again. The network layer
// can perform checks to see if the recepient is the leader and hop to the
// actual leader if it isn't, reject if it is but collapsed.
//
// Once you've externalized this in kibitz, remove it, or pare it down.
Paxos.prototype._enqueuable = function (republic) {
    if (this._writer.collapsed || this.republic != republic) {
        return {
            enqueued: false,
            republic: this.republic,
            leader: null
        }
    }
    if (this.government.majority[0] != this.id) {
        return {
            enqueued: false,
            republic: this.republic,
            leader: this.government.majority[0]
        }
    }
}

// Note that a client will have to treat a network failure on submission as a
// failure requiring boundary detection.
Paxos.prototype.enqueue = function (now, republic, message) {
    var response = this._enqueuable(republic)
    if (response == null) {
// TODO Bombs out the current working promise. TODO YEAH BAD LOOK THINK.
        // TODO Note that we used to snapshot the majority here as the route but
        // that can change. Note that the last issued promise is not driven by
        // government enactment, it is incremented as we greate new promises and
        // governments.
        var promise = this._promised = Monotonic.increment(this._promised, 1)
        this._writer.push({
            promise: promise,
            quorum: this.government.majority,
            body: message
        })
        this._writer.nudge()

        response = {
            enqueued: true,
            leader: this.government.majority[0],
            promise: promise
        }
    }
    return response
}

// TODO This is a note. I'd like to find a place to journal this. I'm continuing
// to take measures to allow for the reuse of ids. It still feels right to me
// that a display of government or of the census would be displayed using values
// meaningful to our dear user; Kubernetes HOSTNAMES, AWS instance names, IP
// address, and not something that is garunteed unique like a UUID, because such
// things are indistinguishable to the human observer.
//
// Yet, here I am again contending with an issue that would be so simple if ids
// where required to be unique. When a citizen that is a constituent dies and
// restarts with the same id it will be pinged by someone in government, it will
// report that it's empty, and its representative will look for it's immigration
// record. There's a race now. Is the new instance going to immigrate before its
// pinged? Or is the representative going to search for an immigration record
// and not find one, which causes us to abend at the moment?
//
// When we get a sync before immigration, it will not see a cookie or not see
// the right cookie and fail the sync. These syncs fail, time passes, the time
// out comes and the record is cleared. That takes care of the race when the
// sync beats the immigration record, but what if the immigration record beats
// the representative?
//
// In that case their will be a new government with the same represenative with
// the same consitutent, but now there will be an immigration record. The
// consituent will be naturalized. It will never have been exiled.
//
// This is a problem. Implementations are going to need to know that they've
// restarted. A participant should be exiled before it can immigrate again.
//
// Obviously, much easier if the ids are unique. Whole new id means not
// ambiguity. The new id immigrates, the old id exiles. (Unique ids are easy
// enough to foist upon our dear user implementation wise. Most implementations
// reset a process or at least an object, and that new instance can have a new
// id generated from POSIX time or UUID.)
//
// However, we do have an atomic log at our disposal, so every time I think that
// I should give up and go with unique ids, something comes along to make it
// simple. I was actually musing about how the client, if they really wanted
// pretty ids, they could just check and wait for the old id to exile, since it
// only needs to be unique in the set of current ids. Then, duh, I can do that
// same check on immigration and reject the immigration if the id already exists
// in the census.
//
// That's what you're looking at here.
//
// Now that that is done, though, is there a race condition where the
// immigration is currently being proposed? The property wouldn't be removed
// until the proposal was enacted.

//
Paxos.prototype.immigrate = function (now, republic, id, cookie, properties) {
    var response = this._enqueuable(republic)
    if (response == null) {
        // Do not allow the user to initiate the immigration of an id that
        // already exists. This will happen if a denizen crash restarts and
        // tries to rejoin before Paxos can determine that the denizen is no
        // longer viable. The immigrating denizen should enter a back off and
        // retry loop in order to wait for exile.
        if (id in this.government.properties) {
            response = {
                enqueued: false,
                republic: this.republic,
                leader: this.government.majority[0]
            }
        } else {
            response = { enqueued: true }

            var shape = this._shaper.immigrate({ id: id, properties: properties, cookie: cookie })
            if (shape != null) {
                this.newGovernment(now, shape.quorum, shape.government)
            }
        }
    }
    return response
}

Paxos.prototype.naturalize = function () {
    this.naturalized = true
}

// ### Scheduled Events

// Timer-driven events are managed using [Happenstance](http://github.com/bigeasy/happenstance).
// Events are scheduled by calling the `schedule` method of a Happenstance
// the `Schedule` object for this citizen. Each event has a key and scheduling
// an event will replace an scheduled event with the same key, making it easy to
// reset timeouts, to basically reset countdowns or replace the countdown action
// as the role of the citizen changes.

//
Paxos.prototype.event = function (envelope) {
    // Other envelope times are related to timer maintenance.
    if (envelope.module != 'happenstance' || envelope.method != 'event') {
        return
    }
    var now = envelope.now
    switch (envelope.body.method) {
    // Send a synchronization message to one or more fellow citizens. Note that
    // the to field is an array.
    case 'synchronize':
        this._send({
            method: 'synchronize',
            version: this.government.promise,
            to: envelope.body.to,
            key: envelope.key
        })
        break
    // Call an assembly; try to reach other members of the government when the
    // current government has collapsed.
    case 'assembly':
        this._pinger = new Pinger(this, this._shaper = new Assembly(this.government, this.id))
        this._pinger.update(now, this.id, {
            naturalized: this.naturalized,
            committed: this.log.head.body.promise
        })

        // TODO This is fine. Realize that immigration is a special type of
        // somethign that is built on top of proposals. Ah, or maybe assembly is the
        // shaper and a shaper creates the next shaper. Thus, shaper is the
        // abstraction that is above writer/recorder. Also, Assembly could be called
        // something else, gatherer or collector or roll call or sergent at arms.

        this.government.majority.concat(this.government.minority)
            .filter(function (id) {
                return id != this.id
            }.bind(this)).forEach(function (id) {
                this.scheduler.schedule(now, id, { method: 'synchronize', to: [ id ] })
            }, this)
        break
    // We are a majority member that has not heard from the leader for longer
    // than the timeout so collapse the current government.
    case 'collapse':
        this._collapse(now)
        break
    }
}

// ### Collapse

// Called by a recorder when a prepare method is received to transition from a
// two-phase commit recorder to a Paxos acceptor.

//
Paxos.prototype._prepare = function (now, request, sync) {
    this._recorder = new Acceptor(this)
    return this._recorder.request(now, request, sync)
}

// Collapse means we schedule and assembly.

//
Paxos.prototype._collapse = function (now) {
    this.scheduler.clear()

    // TODO Really need to have the value for previous, which is the writer register.
    this._writer = new Proposer(this, this.government.promise)
    this._scheduleAssembly(now, false)
}

// Note that even if the PNRG where not determinsitic, it wouldn't matter during
// replay because the delay is lost and the actual timer event is recorded.

// TODO Convince yourself that the above is true and the come back and replace
// this PRNG with `Math.rand()`.

//
Paxos.prototype._scheduleAssembly = function (now, retry) {
    var delay = 0
    if (retry && this.id != this.government.majority[0]) {
        // PRNG: https://gist.github.com/blixt/f17b47c62508be59987b
        delay = time.timeout * (((this._seed = this._seed * 16807 % 2147483647) - 1) / 2147483646)
    }
    this.scheduler.schedule(now + delay, this.id, { method: 'assembly', body: null })
}

// ### Requests and Responses

// Find a round of paxos in the log based on the given promise.
//
// Not loving how deeply nested these conditions and keys are, but I understand
// why it is that way, and it would be a full wrapper of `bintrees` to fix it.

//
Paxos.prototype._findRound = function (sought) {
    return this.indexer.tree.find({ body: { promise: sought } })
}

Paxos.prototype._stuffSynchronize = function (pings, sync, count) {
    var ping = pings[0]
    for (var i = 1, I = pings.length; i < I; i++) {
        assert(ping.committed != null && pings[i].committed != null)
        if (Monotonic.compare(pings[i].committed, ping.committed) < 0) {
            ping = pings[i]
        }
        assert(ping.committed != '0/0')
    }
    var iterator
    if (ping.committed == null) {
        return true
    } else if (ping.committed == '0/0') {
        iterator = this.log.trailer.node.next
        for (;;) {
            assert(iterator != null, 'immigration missing')
            if (Monotonic.isBoundary(iterator.body.promise, 0)) {
                var immigrate = iterator.body.body.immigrate
                if (immigrate && immigrate.id == ping.id) {
                    break
                }
            }
            iterator = iterator.next
        }
    } else {
        assert(Monotonic.compare(ping.committed, this.minimum) >= 0, 'minimum breached')
        assert(Monotonic.compare(ping.committed, this.log.head.body.promise) <= 0, 'maximum breached')
        iterator = this._findRound(ping.committed).next
    }

    while (--count && iterator != null) {
        sync.commits.push({
            promise: iterator.body.promise,
            body: iterator.body.body,
            previous: iterator.body.previous
        })
        iterator = iterator.next
    }

    return true
}

// Package a message with log synchronization messages and put it in our outbox
// for delivery to the intended fellow citizens.
//
// Note that messages can take however long they're going to take. They requests
// can always be received and the responses can always be handled. If they are
// made invalid by their time in transit they will be rejected. Our dear user
// needs only to send the messages to our fellow citiens by any means and
// return the responses to us all at once.

//
Paxos.prototype._send = function (message) {
    var sync = {
        republic: this.republic,
        promise: this.government.immigrated.promise[this.id],
        from: this.id,
        minimum: this.minimum,
        committed: this.log.head.body.promise,
        cookie: this.cookie,
        commits: []
    }
    var pings = []
    for (var i = 0, to; (to = message.to[i]) != null; i++) {
        // TODO Any event races? Make synchronize benign and probably not.
        this.scheduler.unschedule(to)
        pings.push(this._pinger.getPing(to))
    }
    this._stuffSynchronize(pings, sync, 20)
    var envelopes = [], responses = {}
    for (var j = 0, to; (to = message.to[j]) != null; j++) {
        var envelope = {
            to: to,
            from: this.id,
            request: {
                message: message,
                receipts: coalesce(this._receipts[to], {}),
                sync: sync
            },
            responses: responses
        }
        delete this._receipts[to]
        envelopes.push(envelope)
    }
    this.outbox.push({ from: this.id, message: message, responses: responses, envelopes: envelopes })
}

// TODO Note that minimum only ever goes up so a delayed minimum is not going to
// ever be invalid. We don't want to run it in case it rejects our start.

//
Paxos.prototype.request = function (now, request) {
    // TODO Reject if it is the wrong republic.
    // TODO Reject if it a message from an exile, wrong id and cookie.
    var sync = {
        republic: this.republic,
        promise: this.government.immigrated.promise[this.id],
        from: this.id,
        naturalized: this.naturalized,
        minimum: this.minimum,
        committed: this.log.head.body.promise,
        commits: []
    }
    this._shaper.received(request.receipts)
    var message
    if (
        Monotonic.compare(request.sync.committed, sync.committed) < 0
    ) {
        this._stuffSynchronize([ request.sync ], sync, 20)
        // We are ahead of the bozo trying to update us, so update him back.
        message = { method: 'reject', promise: sync.committed }
    } else {
        // Sync.
        this._synchronize(now, request.sync.commits)

        // We don't want to advance the minimum if we have no items yet.
        if (this.log.head.body.promise != '0/0') {
            while (Monotonic.compare(this.log.trailer.peek().promise, request.sync.minimum) < 0) {
                this.log.trailer.shift()
            }
            if (Monotonic.compare(this.minimum, request.sync.minimum) < 0) {
                this.minimum = request.sync.minimum
            }
        }

        if (~this.government.majority.slice(1).indexOf(this.id)) {
            this.scheduler.schedule(now + this.timeout, this.id, {
                module: 'paxos',
                method: 'collapse',
                body: null
            })
        }
        var message = request.message.method == 'synchronize'
                    ? { method: 'respond', promise: sync.committed }
                    : this._recorder.request(now, request.message)
    }
    return {
        message: message,
        sync: sync,
        pings: this._shaper.outbox
    }
}

Paxos.prototype.response = function (now, message, responses) {
    var failed = false, promise = '0/0'

    // Go through responses converting network errors to reject messaages and
    // syncing any commits that where pushed back to us.

    //
    for (var i = 0, I = message.to.length; i < I; i++) {
        var response = responses[message.to[i]]
        if (response == null) {
            failed = true
            responses[message.to[i]] = response = {
                message: { method: 'reject', promise: '0/0' },
                sync: { committed: null },
                pings: {}
            }
            this._pinger.update(now, message.to[i], null)
        } else {
            this._pinger.update(now, message.to[i], response.sync)
            this._synchronize(now, response.sync.commits)
        }
        if (Monotonic.compare(promise, response.message.promise) < 0) {
            promise = response.message.promise
        }
        // TODO Don't be so direct?
        // TODO Who is eliminating duplicates?
        for (var id in response.pings) {
            if (response.pings[id].reachable) {
                this._pinger.update(now, id, response.pings[id])
            } else {
                this._shaper.update(id, false)
            }
        }
        this._receipts[response.sync.from] = response.pings
    }

    // Here's were I'm using messages to drive the algorithm even when the
    // information is available for recalcuation.
    //
    // There are two types of explicit synchronize. The leader will sync its log
    // with its majority, other members of the government will sync with their
    // constituents. With a majority sync, the leader will sync with all of the
    // majority members at once, any one of them failing triggers a collapse.
    //
    // Consistuent synchronize messages are sent to each constituent
    // individually.
    //
    // TODO This is new. Pings keep on going. When you start one it will
    // perpetuate until the government is superceeded. If you want to
    // synchronize before a ping, simply schedule the ping immediately. If there
    // is an outstanding ping when you jump the gun, that's fine. Pings are
    // pretty much always valid. Won't this duplicate mean you now have two ping
    // intervals? No. The duplicate messaging will be reduced when the next ping
    // gets scheduled because you can only have one scheduled per key.

    //
    if (message.method == 'synchronize') {
        // Skip if this synchronization was submitted by an earlier government.
        if (message.version != this.government.promise) {
            return
        }
        // Immediately continue sync if our constituent is not completely
        // synced. Note that majority members are never behind by more than one,
        // so they always successfully sync. This is why we only check the first
        // response, because only a constituent sync can fail to successfully
        // sync. TODO How do we detect a failed immigration race again?
        //
        // Node that a `null` value for `committed` indicates a network timeout
        // which is set above in the response refactoring.
        var delay = 0
        if (
            ~([ null, this.log.head.body.promise ]).indexOf(responses[message.to[0]].sync.committed)
        ) {
            delay = this.ping
        }

        // Schedule the next synchronization.
        if (
            message.key != this.id ||
            ! this._writer.collapsed
        ) {
            this.scheduler.schedule(now + delay, message.key, { method: 'synchronize', to: message.to })
        }

        return
    }
    // TODO If the recepient is at '0/0' and we attempted to synchronize it,
    // then we must not have had the right cookie, let's mark it as unreachable
    // for exile.

    // Only handle a response if it was issued by our current writer/proposer.
    if (
        message.version[0] == this._writer.version[0] &&
        message.version[1] == this._writer.version[1]
    ) {
        this._writer.response(now, message, responses, failed ? promise : null)
    }

    // Determine the minimum log entry promise.
    //
    // You might feel a need to guard this so that only the leader runs it, but
    // it works of anyone runs it. If they have a ping for every citizen,
    // they'll calculate a minimum less than or equal to the minimum calculated
    // by the actual leader. If not they do not have a ping record for every
    // citizen, they'll continue to use their current minimum.
    //
    // Would rather this was on object that was updated only when we got ping
    // information back.

    //
    var minimum = this.log.head.body.promise
    for (var i = 0, citizen; (citizen = this.citizens[i]) != null; i++) {
        var ping = this._pinger.pings[citizen]
        if (ping == null || ping.committed == null) {
            return
        }
        if (Monotonic.compare(ping.committed, minimum) < 0) {
            minimum = ping.committed
        }
    }
    this.minimum = minimum
}

// ### Commit

Paxos.prototype._register = function (now, register) {
    var entries = []
    while (register) {
        entries.push(register.body)
        register = register.previous
    }

    entries.reverse()

    for (var i = 0, entry; (entry = entries[i]) != null; i++) {
        this._commit(now, entry, this.log.head.body.promise)
    }
}

Paxos.prototype._synchronize = function (now, entries) {
    if (entries.length != 0) {
        var top = this.log.head.body.promise
        if (top == '0/0') {
            // If we are immigrating or bootstrapping we ensure that we're
            // starting with the the entry that announces our immigration.
            // Otherwise we may have lost an immigration race condition.
            if (
                !Monotonic.isBoundary(entries[0].promise, 0) ||
                entries[0].body.immigrate == null ||
                entries[0].body.immigrate.id != this.id ||
                entries[0].body.immigrate.cookie != this.cookie
            ) {
                return false
            }
            top = entries[0].previous
        }
        for (var i = 0, entry; (entry = entries[i]) != null; i++) {
            this._commit(now, entry, top)
            top = this.log.head.body.promise
        }
    }
    return true
}

Paxos.prototype._commit = function (now, entry, top) {
    entry = JSON.parse(JSON.stringify(entry))

    logger.info('_receiveEnact', { now: now, $entry: entry })

    // We already have this entry. The value is invariant, so let's assert
    // that the given value matches the one we have.

    //
    if (Monotonic.compare(entry.promise, top) <= 0) {
        // Difficult to see how we could get here and not have a copy of the
        // message in our log. If we received a delayed sync message that
        // has commits that precede our minimum, seems like it would have
        // been rejected at entry, the committed versions would be off.

        //
        if (Monotonic.compare(this.minimum, entry.promise) <= 0) {
            departure.raise(this._findRound(entry.promise).body.body, entry.body)
        } else {
            // Getting this branch will require
            //
            // * isolating the minority member so that it is impeached.
            // * collapsing the consensus so the unreachability is lost.
            //      * note that only the leader is guarded by its writer.
            //      * reset unreachability means timeout needs to pass
            //      again.
            //      * if you preserve pings, then the same effect can be had
            //      by killing the leader and majority member that
            //      represents the minority member, since reacability is
            //      only present in a path.
            // * add new entries to the log so that the isolate former
            // minority member is behind.
            // * have the former minority member sync a constituent, the
            // constituent will respond with a sync, delay the response.
            // * bring the minority member up to speed.
            // * let new minimum propigate.
            // * send the delayed response.

            //
        }
        return
    }

    // Otherwise, we assert that entry has a correct previous promise.
    assert(top == entry.previous, 'incorrect previous')

    var isGovernment = Monotonic.isBoundary(entry.promise, 0)
    logger.info('enact', {
        outOfOrder: !(isGovernment || Monotonic.increment(top, 1) == entry.promise),
        isGovernment: isGovernment,
        $entry: entry
    })

    if (isGovernment) {
        this.scheduler.clear()

        assert(Monotonic.compare(this.government.promise, entry.promise) < 0, 'governments out of order')

        this.government = entry.body

        constituency(this.government, this.id, this)

        this._writer = this._writer.createWriter(entry.promise)
        this._recorder = this._recorder.createRecorder(entry.promise)

        // Chose a strategy for handling pings.
        var shaper
        if (this.id == this.government.majority[0]) {
            // If we are the leader, we are going to want to look for
            // opportunities to change the shape of the government.
            shaper = new Shaper(this.parliamentSize, this.government)
            for (var i = 0, immigration; (immigration = this._shaper._immigrating[i]) != null; i++) {
                shaper.immigrate(immigration)
            }
        } else {
            // If we are a represenative we want to propagate our pings to the
            // leader through our representative (which may be the leader.)
            var representative = this.government.promise[this.representative]
            if (representative != this._shaper._representative) {
                shaper = new Relay(representative)
            } else {
                shaper = this._shaper
            }
        }
        this._shaper = shaper

        if (this.government.exile) {
            // TODO Remove! Fall back to a peek at exile.
            delete this.pings[this.government.exile.id]
        } else if (this.government.immigrate && this.government.majority[0] == this.id) {
            this._shaper.immigrated(this.government.immigrate.id)
        }

        if (~this.government.majority.indexOf(this.id)) {
            this.scheduler.schedule(now + this.ping, this.id, {
                module: 'paxos',
                method: 'collapse',
                body: null
            })
        }

        // Reset ping tracking information. Leader behavior is different from
        // other members. We clear out all ping information for ping who are not
        // our immediate constituents. This will keep us from hoarding stale
        // ping records. When everyone performs this cleaning, we can then trust
        // ourselves to return all ping information we've gathered to anyone
        // that pings us, knowing that it is all flowing from minority members
        // to the leader. We do not have to version the records, timestamp them,
        // etc.
        //
        // If we didn't clear them out, then a stale record for a citizen can be
        // held onto by a majority member. If the minority member that pings the
        // citizen is no longer downstream from the majority member, that stale
        // record will not get updated, but it will be reported to the leader.
        //
        // We keep ping information if we are the leader, since it all flows
        // back to the leader. All leader information will soon be updated. Not
        // resetting the leader during normal operation makes adjustments to
        // citizenship go faster.
        this.citizens = this.government.majority
                            .concat(this.government.minority)
                            .concat(this.government.constituents)
        this._pinger = this._pinger.createPinger(now, this, this._shaper)
    }

    assert(entry.previous, 'null previous')
    this.log.push({
        module: 'paxos',
        method: isGovernment ? 'government' : 'entry',
        promise: entry.promise,
        body: entry.body,
        previous: entry.previous
    })

    // Notify our constituents of a new update.

    // TODO This is my we give the leader a zero constituency. Why did we change
    // it to point to the remainder of the majority?

    // TODO Recall that we're not going to continue to ping our constituents
    // when it comes time to conduct an assembly, so we'll ping, but not update
    // the constituency.

    // We count on our writer to set the final synchronize when we are the
    // leader of a government that is not a dictatorship.
    if (
        this.id != this.government.majority[0] ||
        this.government.majority.length == 1
    ) {
        for (var i = 0, id; (id = this.constituency[i]) != null; i++) {
            this.scheduler.schedule(now, id, { method: 'synchronize', to: [ id ] })
        }
    }
}

module.exports = Paxos
