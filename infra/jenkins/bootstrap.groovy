// One-time init on the migrated controller. Existing users/credentials are preserved.
import jenkins.model.Jenkins
import hudson.model.Node
import hudson.model.User
import hudson.slaves.DumbSlave
import hudson.slaves.RetentionStrategy
import hudson.slaves.JNLPLauncher
import jenkins.security.ApiTokenProperty
import jenkins.model.JenkinsLocationConfiguration

def instance = Jenkins.get()
assert instance.isUseSecurity(): 'Refuse to expose an unsecured controller'
instance.setNumExecutors(0)
instance.setSlaveAgentPort(-1)
if (instance.getNode('linux-docker-builder') == null) {
    def launcher = new JNLPLauncher()
    launcher.setWebSocket(true)
    def node = new DumbSlave('linux-docker-builder', '/home/jenkins/agent', launcher)
    node.setNumExecutors(1)
    node.setLabelString('linux-docker-builder')
    node.setMode(Node.Mode.EXCLUSIVE)
    node.setRetentionStrategy(new RetentionStrategy.Always())
    instance.addNode(node)
}
instance.getAllItems(hudson.model.Job).each { job ->
    if (job instanceof org.jenkinsci.plugins.workflow.job.WorkflowJob) {
        job.setDisabled(true)
        job.save()
    }
}
JenkinsLocationConfiguration.get().setUrl('https://13.209.59.180/jenkins/')
JenkinsLocationConfiguration.get().save()
instance.save()
def output = new File('/run/bootstrap-output')
output.mkdirs()
def secretFile = new File(output, 'agent-secret')
secretFile.text = instance.getComputer('linux-docker-builder').getJnlpMac()
secretFile.setReadable(false, false)
secretFile.setReadable(true, true)
secretFile.setWritable(false, false)
secretFile.setWritable(true, true)
def originalAdmin = User.getById('jlkim909', false)
assert originalAdmin != null: 'Expected source administrator account is missing'
def originalDetails = originalAdmin.getProperty(hudson.security.HudsonPrivateSecurityRealm.Details)
assert originalDetails != null: 'Expected local password authentication'
def admin = User.getById('dva-admin', false)
if (admin == null) {
    admin = instance.getSecurityRealm().createAccountWithHashedPassword('dva-admin', originalDetails.getPassword())
    admin.setFullName('Dva 관리자')
    admin.save()
}
def property = admin.getProperty(ApiTokenProperty)
def token = property.tokenStore.generateNewToken('lightsail-migration-bootstrap')
admin.save()
def authFile = new File(output, 'migration-auth')
authFile.text = admin.getId() + '\n' + token.plainValue + '\n'
authFile.setReadable(false, false)
authFile.setReadable(true, true)
authFile.setWritable(false, false)
authFile.setWritable(true, true)
println('Lightsail bootstrap completed: controller executors=0, Linux agent executors=1.')
