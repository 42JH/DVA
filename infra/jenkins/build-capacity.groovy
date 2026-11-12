import jenkins.model.Jenkins

// All Linux jobs share the one-CPU build daemon.
def node = Jenkins.get().getNode('linux-docker-builder')
if (node != null && node.numExecutors != 1) {
    node.numExecutors = 1
    node.save()
}
