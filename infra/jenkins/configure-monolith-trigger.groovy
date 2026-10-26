import jenkins.model.Jenkins
import hudson.util.Secret
import org.jenkinsci.plugins.workflow.job.WorkflowJob
import org.jenkinsci.plugins.gwt.GenericTrigger
import org.jenkinsci.plugins.gwt.GenericVariable
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest

// Run in the authenticated Jenkins Script Console. Never print the webhook token.
def instance = Jenkins.get()
def job = instance.getItemByFullName('dva-ci-linux-validation', WorkflowJob)
assert job != null
assert !job.isBuilding() && !job.isInQueue(): 'Wait until the monolith job is idle.'
assert job.definition.scriptPath == 'Jenkinsfile'
assert job.definition.scm.branches*.name == ['*/develop-backend']
def msa = instance.getItemByFullName('dva-msa', WorkflowJob)
def sha256 = { byte[] data -> MessageDigest.getInstance('SHA-256').digest(data).encodeHex().toString() }
def msaBefore = sha256(msa.configFile.file.bytes)
def old = job.triggers.values().find { it.class.name == 'com.dabsquared.gitlabjenkins.GitLabPushTrigger' }
def current = job.triggers.values().find { it instanceof GenericTrigger }
assert old != null || current != null: 'An existing webhook token is required.'
def token = old != null ? Secret.fromString(old.secretToken).plainText : current.token
assert token != null && !token.isBlank()

def variables = [
    monolith_event: '$.object_kind',
    monolith_project: '$.project.id',
    monolith_ref: '$.ref',
    monolith_after: '$.after',
    monolith_count: '$.total_commits_count',
    monolith_paths: "\$.commits[*]['added','modified','removed'][*]"
].collect { key, value -> new GenericVariable(key, value) }
def trigger = new GenericTrigger(variables, [], [])
trigger.setToken(token)
trigger.setCauseString('GitLab monolith path filter: $monolith_ref')
trigger.setPrintContributedVariables(false)
trigger.setPrintPostContent(false)
trigger.setSilentResponse(false)
trigger.setShouldNotFlatten(true)
trigger.setAllowSeveralTriggersPerBuild(false)
trigger.setRegexpFilterText('$monolith_event|$monolith_project|$monolith_ref|$monolith_after|$monolith_count|$monolith_paths')
// GitLab truncates commits at 20. Larger pushes conservatively run to avoid missing builds.
trigger.setRegexpFilterExpression('(?s)^push\\|1462697\\|refs/heads/develop-backend\\|(?!0{40}\\|)[0-9a-f]{40}\\|(?:[0-9]+\\|.*"(?:backend/[^"\\r\\n]*|Jenkinsfile|compose(?:\\.prod)?\\.yaml|infra/(?:deploy|nginx|https|jenkins)/[^"\\r\\n]*|\\.gitattributes)".*|(?:2[1-9]|[3-9][0-9]|[1-9][0-9]{2,})\\|.*)$')

def backupDir = new File(instance.rootDir, 'monolith-trigger-backups')
Files.createDirectories(backupDir.toPath())
Files.setPosixFilePermissions(backupDir.toPath(), PosixFilePermissions.fromString('rwx------'))
def backup = new File(backupDir, "config-${System.currentTimeMillis()}.xml")
Files.write(backup.toPath(), job.configFile.file.bytes)
Files.setPosixFilePermissions(backup.toPath(), PosixFilePermissions.fromString('rw-------'))
try {
    job.setTriggers(job.triggers.values().findAll {
        it.class.name != 'com.dabsquared.gitlabjenkins.GitLabPushTrigger' && !(it instanceof GenericTrigger)
    } + [trigger])
    job.save()
    Files.setPosixFilePermissions(job.configFile.file.toPath(), PosixFilePermissions.fromString('rw-------'))
    assert sha256(msa.configFile.file.bytes) == msaBefore: 'MSA configuration changed unexpectedly.'
} catch (Throwable failure) {
    job.updateByXml(new javax.xml.transform.stream.StreamSource(backup))
    throw failure
}
println('Configured monolith path filtering; existing webhook token preserved; MSA configuration unchanged.')
println('Backup: ' + backup.name)
