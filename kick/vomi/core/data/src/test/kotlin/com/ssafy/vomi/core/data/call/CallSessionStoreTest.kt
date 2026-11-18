package com.ssafy.vomi.core.data.call

import com.ssafy.vomi.core.model.call.CallConnection
import com.ssafy.vomi.core.model.call.CallSession
import com.ssafy.vomi.core.model.call.CallSnapshot
import com.ssafy.vomi.core.model.call.CallStatus
import org.junit.Assert.*
import org.junit.Test

class CallSessionStoreTest {
    private val requested = CallSession("call-1", "kick-test-1", "kick-test-2", CallStatus.REQUESTED)
    private fun ready() = CallSessionStore().apply { beginSession("kick-test-1"); setConnection("kick-test-1", CallConnection.Connected) }

    @Test fun creationGuardAndResetAreIndependentOfAuthenticationAndNetwork() {
        val store = ready()
        assertTrue(store.tryStartCreating("kick-test-1"))
        assertFalse(store.tryStartCreating("kick-test-1"))
        store.finishCreating("kick-test-1")
        store.applyCall(requested, "kick-test-1")
        store.clear()
        assertNull(store.state.value.session)
        assertNull(store.state.value.accountId)
    }
    @Test fun delayedRequestedResponseCannotRegressAcceptedState() {
        val store = ready()
        store.applySnapshot(CallSnapshot("kick-test-1", requested.copy(status = CallStatus.ACCEPTED)), "kick-test-1")
        store.applyCall(requested, "kick-test-1")
        assertEquals(CallStatus.ACCEPTED, store.state.value.session!!.status)
    }
    @Test fun nullSnapshotPreventsLateResponseFromRevivingFinishedCall() {
        val store = ready()
        store.applyCall(requested, "kick-test-1")
        store.applySnapshot(CallSnapshot("kick-test-1", null), "kick-test-1")
        store.applyCall(requested, "kick-test-1")
        assertNull(store.state.value.session)
    }
    @Test fun clearingSessionRejectsResultsOwnedByThePreviousUser() {
        val store = ready()
        store.clear()
        store.applyCall(requested, "kick-test-1")
        assertNull(store.state.value.session)
    }
}
