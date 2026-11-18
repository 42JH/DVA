package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.network.model.friend.FriendResponse
import com.ssafy.vomi.core.network.service.friend.FriendClient
import com.ssafy.vomi.core.network.service.friend.FriendService
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.single
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class FriendRepositoryImplTest {
    private class Service : FriendService {
        var requests = 0
        var response = listOf(FriendResponse("kick-test-2", "테스트 계정 2"))
        var failure: Exception? = null
        override suspend fun getFriends(): List<FriendResponse> {
            requests++
            failure?.let { throw it }
            return response
        }
        override suspend fun addFriend(friendId: String): FriendResponse = error("Unused")
    }

    @Test fun mapsServerIdsAndNamesWithoutInventingProfileImages() = runTest {
        val repository = FriendRepositoryImpl(FriendClient(Service()), StandardTestDispatcher(testScheduler))
        val friend = repository.getFriends().single().single()
        assertEquals("kick-test-2", friend.id)
        assertEquals("테스트 계정 2", friend.name)
        assertNull(friend.profileImageUrl)
    }

    @Test fun requestsAreColdAndEachCollectionFetchesFreshData() = runTest {
        val service = Service()
        val repository = FriendRepositoryImpl(FriendClient(service), StandardTestDispatcher(testScheduler))
        val friends = repository.getFriends()
        assertEquals(0, service.requests)
        friends.single()
        service.response = listOf(FriendResponse("kick-test-1", "테스트 계정 1"))
        assertEquals("kick-test-1", friends.single().single().id)
        assertEquals(2, service.requests)
    }

    @Test fun emptyServerListRemainsEmpty() = runTest {
        val service = Service().apply { response = emptyList() }
        val repository = FriendRepositoryImpl(FriendClient(service), StandardTestDispatcher(testScheduler))
        assertTrue(repository.getFriends().single().isEmpty())
    }

    @Test fun requestFailuresAreNotConvertedIntoAnEmptySuccess() = runTest {
        val failure = IOException("offline")
        val service = Service().apply { this.failure = failure }
        val repository = FriendRepositoryImpl(FriendClient(service), StandardTestDispatcher(testScheduler))
        try { repository.getFriends().single(); fail("Expected request failure") }
        catch (error: IOException) { assertEquals(failure.message, error.message) }
    }

    @Test fun cancellationRemainsCancellation() = runTest {
        val failure = CancellationException("cancelled")
        val service = Service().apply { this.failure = failure }
        val repository = FriendRepositoryImpl(FriendClient(service), StandardTestDispatcher(testScheduler))
        try { repository.getFriends().single(); fail("Expected cancellation") }
        catch (_: CancellationException) { }
    }
}
