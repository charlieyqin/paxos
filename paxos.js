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
var Proposer = require('./proposer')
var Acceptor = require('./acceptor')

// The participants in the two-phase commit strategy.
var Shaper = require('./shaper')
var Writer = require('./writer')
var Recorder = require('./recorder')

var departure = require('departure')
var Constituency = require('./constituency')

// ### Constructor
function Paxos (now, republic, id, options) {
    // Uniquely identify ourselves relative to the other participants.
    this.id = String(id)

    // Use the create time as a cookie to identify this instance of this id.
    this.cookie = now

    // A republic identifies a paritcular instance of the Paxos algorithm.
    this.republic = republic

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

    // Upper bound of the atomic log.
    this._committed = {}

    // Propagated lower bound of the atomic log.
    this._minimum = { propagated: '0/0', version: '0/0', reduced: '0/0' }
    this._minimums = {}
    this._minimums[this.id] = this._minimum

    // Network message queue.
    this.outbox = new Procession

    // Push the null government onto the atomic log.
    this.log.push({
        module: 'paxos',
        method: 'government',
        promise: '0/0',
        body: this.government,
        previous: null
    })

    // Write strategy is polymorphic, changes based on whether we're recovering
    // from collapse uing Paxos or writing values using two-phase commit.
    this._writer = new Writer(this, '1/0')
    this._recorder = new Recorder(this, this.log.head.body)

    // Shaper a new government by fiat based on whose availble to grow to the
    // desired government size and who is unreachable.
    this._shaper = new Shaper(this.parliamentSize, this.government)

    // Used for our pseudo-random number generator to vary retry times.
    this._seed = 1

    // Track unreachable citizens.
    this._disappeared = {}
    this._unreachable = {}
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
    // TODO Will fail on multiple rounds of Paxos.
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
        government.exile = {
            id: exile,
            promise: immigrated.promise[exile],
            properties: properties[exile]
        }
        delete immigrated.id[immigrated.promise[exile]]
        delete immigrated.promise[exile]
        delete properties[exile]
        government.constituents.splice(government.constituents.indexOf(exile), 1)
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

    //
    case 'synchronize':
        this._send({
            method: 'synchronize',
            version: this.government.promise,
            to: envelope.body.to,
            collapsible: !! envelope.body.collapsible,
            constituent: true,
            key: envelope.key
        })
        break

    // We are a majority member that has not heard from the leader for longer
    // than the timeout so collapse the current government. This turns our
    // `Writer` into a `Proposer` and starts running Paxos.

    //
    case 'collapse':
        this._collapse(now)
        break

    // Prepare a round of Paxos. We pick from the legislators that have not
    // disappeared. If a majority of legislators have disappeared, we reset our
    // disappeared map and try anyway because what else are we going to do? Note
    // that we ignore the unreachable map during a collapse.
    //
    // TODO Collapse means Paxos. Put that in the documentation somewhere.

    //
    case 'propose':
        for (;;) {
            // If we win, we are the leader.
            var majority = [ this.id ]
            var minority = []

            // Try to find a majority of legislators.
            var parliament = this.government.majority.concat(this.government.minority)
            while (parliament.length != 0) {
                var id = parliament.shift()
                if (id != this.id) {
                    if (
                        majority.length == this.government.majority.length ||
                        this._disappeared[this.government.immigrated.promise[id]] != null
                    ) {
                        minority.push(id)
                    } else {
                        majority.push(id)
                    }
                }
            }

            // If we have a majority of legislators, we have have run a
            // forming this government with ourselves as leader.
            if (majority.length == this.government.majority.length) {
                this.newGovernment(now, majority, { majority: majority, minority: minority })
                break
            }

            // If we don't have enough reachable participants for a majority,
            // clear out our disappearance tracking in a desperate move.
            this._disappeared = {}
        }
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

// Collapse means we schedule a round of Paxos.

//
Paxos.prototype._collapse = function (now) {
    this.scheduler.clear()

    // TODO Really need to have the value for previous, which is the writer register.
    this._writer = new Proposer(this, this.government.promise)
    this._propose(now, false)
}

// Note that even if the PNRG where not determinsitic, it wouldn't matter during
// replay because the delay is lost and the actual timer event is recorded.

// TODO Convince yourself that the above is true and the come back and replace
// this PRNG with `Math.rand()`. TODO Meh.

// TODO Consider how to back off. If the leader is gone and two majority members
// are competing, do we really want them backing off for approaching "timeout"
// milliseconds? How fast does it take to complete a round of Paxos and how big
// of a window do we want to give two or more citizens to launch their retries
// such that they avoid collision?

//
Paxos.prototype._propose = function (now, retry) {
    var delay = 0
    if (retry && this.id != this.government.majority[0]) {
        // PRNG: https://gist.github.com/blixt/f17b47c62508be59987b
        delay = (this._seed = this._seed * 16807 % 2147483647) % this.timeout
    }
    this.scheduler.schedule(now + delay, this.id, { method: 'propose', body: null })
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

Paxos.prototype._sync = function (id, committed, count) {
    var sync = {
        republic: this.republic,
        promise: this.government.immigrated.promise[this.id],
        from: this.id,
        minimum: this._minimum,
        committed: this.log.head.body.promise,
        commits: []
    }
    if (committed != null) {
        var iterator
        if (committed == '0/0') {
            iterator = this.log.trailer.node.next
            for (;;) {
                assert(iterator != null, 'immigration missing')
                if (Monotonic.isBoundary(iterator.body.promise, 0)) {
                    var immigrate = iterator.body.body.immigrate
                    if (immigrate && immigrate.id == id) {
                        break
                    }
                }
                iterator = iterator.next
            }
        } else {
            assert(Monotonic.compare(committed, this._minimum.propagated) >= 0, 'minimum breached')
            assert(Monotonic.compare(committed, this.log.head.body.promise) <= 0, 'maximum breached')
            iterator = this._findRound(committed).next
        }

        while (--count && iterator != null) {
            sync.commits.push({
                promise: iterator.body.promise,
                body: iterator.body.body,
                previous: iterator.body.previous
            })
            iterator = iterator.next
        }
    }
    return sync
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
    var envelopes = [], responses = {}
    for (var j = 0, to; (to = message.to[j]) != null; j++) {
        this.scheduler.unschedule(to)
        var sync = {
            republic: this.republic,
            promise: this.government.immigrated.promise[this.id],
            from: this.id,
            minimum: this._minimum,
            committed: this.log.head.body.promise,
            commits: []
        }
        // TODO Tidy.
        var envelope = {
            to: to,
            from: this.id,
            request: {
                message: message,
                sync: this._sync(to, this._committed[this.government.immigrated.promise[to]], 24)
            },
            responses: responses
        }
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
        minimum: this._minimum,
        committed: this.log.head.body.promise,
        commits: []
    }
    if (Monotonic.compare(this._minimum.propagated, request.sync.minimum.propagated) < 0) {
        this._minimum.propagated = request.sync.minimum.propagated
    }

    var message, syncFrom = null
    if (
        Monotonic.compare(request.sync.committed, sync.committed) < 0
    ) {
        syncFrom = request.sync.committed
        // We are ahead of the bozo trying to update us, so update him back.
        message = { method: 'reject', promise: sync.committed }
    } else if (!this._synchronize(now, request.sync.commits)) {
        message = { method: 'unreachable' }
    } else {
        sync.committed = this.log.head.body.promise

        // We don't want to advance the minimum if we have no items yet.
        if (this.log.head.body.promise != '0/0') {
            while (Monotonic.compare(this.log.trailer.peek().promise, this._minimum.propagated) < 0) {
                this.log.trailer.shift()
            }
        }

        if (~this.government.majority.slice(1).indexOf(this.id)) {
            this.scheduler.schedule(now + this.timeout, this.id, {
                module: 'paxos',
                method: 'collapse',
                body: null
            })
        }

        message = request.message.method == 'synchronize'
                ? { method: 'respond', promise: sync.committed }
                : this._recorder.request(now, request.message)
    }
    return {
        message: message,
        sync: this._sync(request.sync.from, syncFrom, 24),
        minimum: this._minimum,
        unreachable: this._unreachable
    }
}

Paxos.prototype.response = function (now, message, responses) {
    // Perform housekeeping for each receipent of the message.

    //
    for (var i = 0, I = message.to.length; i < I; i++) {
        // Deduce receipent properties.
        var id = message.to[i]
        var response = responses[id]
        var promise = this.government.immigrated.promise[id]

        // Go through responses converting network errors to "unreachable"
        // messages with appropriate defaults.
        if (response == null || response.message.method == 'unreachable') {
            responses[message.to[i]] = response = {
                message: { method: 'unreachable', promise: '0/0' },
                sync: { committed: null, commits: [] },
                minimum: null,
                unreachable: {}
            }
            if (message.collapsible) {
                this._collapse(now)
            }
            if (this._disappeared[promise] == null) {
                this._disappeared[promise] = now
            } else if (now - this._disappeared[promise] >= this.timeout) {
                response.unreachable[promise] = true
            }
        } else {
            delete this._disappeared[promise]
        }

        if (response.sync.committed != null) {
            this._committed[promise] = response.sync.committed
        }

        // Synchronize commits.
        this._synchronize(now, response.sync.commits)

        // Update set of unreachable citizens.
        for (var unreachable in response.unreachable) {
            if (!this._unreachable[unreachable]) {
                this._unreachable[unreachable] = response.unreachable[unreachable]
                this._reshape(now, this._shaper.unreachable(this.government.immigrated.id[unreachable]))
            }
        }

        // Reduce our least committed promise. Would switch to using promises as
        // the key in the minimum map, but out of date minimum records are never
        // able to do any damage. They will get updated eventually.
        var minimum = response.minimum
        if (
            message.constituent &&
            minimum &&
            (
                this._minimums[message.to[i]] == null ||
                this._minimums[message.to[i]].version != minimum.version ||
                this._minimums[message.to[i]].reduced != minimum.reduced
            )
        ) {
            this._minimums[message.to[i]] = {
                version: minimum.version,
                propagated: minimum.propagated,
                reduced: minimum.reduced
            }

            var reduced = this.log.head.body.promise

            for (var j = 0, constituent; (constituent = this.constituency[j]) != null; j++) {
                if (
                    this._minimums[constituent] == null ||
                    this._minimums[constituent].version != this.government.promise ||
                    this._minimums[constituent].reduced == '0/0'
                ) {
                    reduced = '0/0'
                    break
                }
                if (Monotonic.compare(this._minimums[constituent].reduced, reduced) < 0) {
                    reduced = this._minimums[constituent].reduced
                }
            }

            this._minimum = {
                propagated: this.id == this.government.majority[0] ? reduced : this._minimum.propagated,
                version: this.government.promise,
                reduced: reduced
            }
        }
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
            this.scheduler.schedule(now + delay, message.key, {
                method: 'synchronize', to: message.to, collapsible: message.collapsible
            })
        }
    } else if (
        message.version[0] == this._writer.version[0] &&
        message.version[1] == this._writer.version[1]
    ) {
        // TODO If the recepient is at '0/0' and we attempted to synchronize it,
        // then we must not have had the right cookie, let's mark it as
        // unreachable for exile.

        // Only handle a response if it was issued by our current
        // writer/proposer.

        // TODO I don't like how the `Recorder` gets skipped on collapse, but
        // the `Acceptor` handles it's own failures. My fastidiousness tells my
        // that this one bit of reject logic escaping to another function in
        // another file is an indication of poor design and that a design
        // pattern is required to make this architecturally sound. However, the
        // bit that is escaping is the only bit that will be dealing with
        // inspecting returned promises and deciding a specific next action, it
        // is Paxos logic that does not otherwise exist, it might actually be an
        // additional layer.

        //
        this._writer.response(now, message, responses)
    }
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

Paxos.prototype._reshape = function (now, shape) {
    if (shape != null) {
        this.newGovernment(now, shape.quorum, shape.government)
    }
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
        if (Monotonic.compare(this._minimum.propagated, entry.promise) <= 0) {
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
            // * let new minimum propagate.
            // * send the delayed response.

            //
        }
        return
    }

    // Otherwise, we assert that entry has a correct previous promise.
    assert(top == entry.previous, 'incorrect previous')

    var isGovernment = Monotonic.isBoundary(entry.promise, 0)
    assert(isGovernment || Monotonic.increment(top, 1) == entry.promise)
    logger.info('enact', { isGovernment: isGovernment, $entry: entry })

    if (isGovernment) {
        this.scheduler.clear()

        assert(Monotonic.compare(this.government.promise, entry.promise) < 0, 'governments out of order')

        this.government = entry.body

        // If we collapsed and ran Paxos we would have carried on regardless of
        // unreachability until we made progress. During Paxos we ignore
        // unreacability so we delete it here in case we happened to make
        // progress in spite of it.
        if (this.government.map == null) {
            for (var i = 0, id; (id = this.government.majority[i]) != null; i++) {
                // TODO Probably okay to track by id. The worst that you can do
                // is delete reachable information that exists for a subsequent
                // version, well, the wrost you can do is get rid of informaiton
                // that will once again materialize.
                delete this._unreachable[this.government.immigrated.promise[id]]
            }
            for (var i = 0, id; (id = this.government.minority[i]) != null; i++) {
                delete this._unreachable[this.government.immigrated.promise[id]]
            }
        }

        Constituency(this.government, this.id, this)
        this.citizens = this.government.majority
                            .concat(this.government.minority)
                            .concat(this.government.constituents)

        this._writer = this._writer.createWriter(entry.promise)
        this._recorder = this._recorder.createRecorder(entry.promise)

        // Chose a strategy for handling pings.
        if (this.id == this.government.majority[0]) {
            // If we are the leader, we are going to want to look for
            // opportunities to change the shape of the government.
            var shaper = new Shaper(this.parliamentSize, this.government)
            for (var i = 0, immigration; (immigration = this._shaper._immigrating[i]) != null; i++) {
                shaper.immigrate(immigration)
            }
            this._shaper = shaper
            if (this.government.immigrate) {
                shaper.immigrated(this.government.immigrate.id)
            }
            for (var promise in this._unreachable) {
                this._reshape(now, shaper.unreachable(this.government.immigrated.id[promise]))
            }
            this.citizens.forEach(function (id) {
                this._reshape(now, shaper.naturalized(id))
            }, this)
        } else {
            this._shaper = {
                unreachable: function () {},
                naturalized: function () {},
                _immigrating: []
            }
        }

        if (~this.government.majority.indexOf(this.id)) {
            this.scheduler.schedule(now + this.ping, this.id, {
                module: 'paxos',
                method: 'collapse',
                body: null
            })
        }

        this._minimum = {
            version: this.government.promise,
            propagated: this._minimum.propagated,
            reduced: this._minimum.reduced,
        }

        var minimums = {}, committed = {}
        for (var i = 0, id; (id = this.constituency[i]) != null; i++) {
            minimums[id] = coalesce(this._minimums[id])
            var promise = this.government.immigrated.promise[id]
            committed[promise] = this._committed[promise]
        }
        this._minimums = minimums
        this._committed = committed

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
    }

    if (this.constituency.length == 0) {
        this._minimum.reduced = entry.promise
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
    // when it comes time to noodle a Paxos waffle, so we'll ping, but not
    // update the constituency. TODO This is old and getting goofy.

    // We count on our writer to set the final synchronize when we are the
    // leader of a government that is not a dictatorship.
    if (this.id != this.government.majority[0] || this.government.majority.length == 1) {
        for (var i = 0, id; (id = this.constituency[i]) != null; i++) {
            this.scheduler.schedule(now, id, { method: 'synchronize', to: [ id ] })
        }
    }
}

module.exports = Paxos
