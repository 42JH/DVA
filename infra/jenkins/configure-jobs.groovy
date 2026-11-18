import jenkins.model.Jenkins
import hudson.plugins.git.GitSCM
import hudson.plugins.git.BranchSpec
import org.jenkinsci.plugins.workflow.job.WorkflowJob
import org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition
import org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition

def instance = Jenkins.get()
def original = instance.getItemByFullName('dva-ci', WorkflowJob)
assert original != null: 'Migrated dva-ci job missing'
assert original.definition instanceof CpsScmFlowDefinition
def scm = original.definition.scm
assert scm instanceof GitSCM
def targetScm = new GitSCM(scm.userRemoteConfigs, [new BranchSpec('*/develop-backend')],
    false, [], null, null, [])
def definition = new CpsScmFlowDefinition(targetScm, 'Jenkinsfile')
definition.setLightweight(true)
original.setDefinition(definition)
original.setDisabled(true)
original.save()

// Validate the unpushed Linux pipeline against the real GitLab checkout.
// Only the CI/deployment scripts are overlaid; application code comes from develop-backend.
def source = new File('/var/jenkins_home/migration-Jenkinsfile').getText('UTF-8')
assert source.contains('checkout scm')
source = source.replace('checkout scm', '''checkout([$class: 'GitSCM',
    branches: [[name: '*/develop-backend']],
    userRemoteConfigs: [[url: 'https://lab.ssafy.com/s15-final/S15P31D109.git', credentialsId: 'gitlab-dva-readonly']]])
                sh 'cp -R /opt/dva-ci-validation/infra/deploy/. infra/deploy/' ''')
source = source.replace('env.RELEASE_VERSION = "', 'env.RELEASE_VERSION = "jenkins-linux-')
def check = instance.getItemByFullName('dva-ci-linux-validation', WorkflowJob)
if (check == null) check = instance.createProject(WorkflowJob, 'dva-ci-linux-validation')
check.setDefinition(new CpsFlowDefinition(source, true))
check.setDescription('Lightsail 이전 검증: develop-backend 앱 소스 + 아직 push하지 않은 Linux CI 스크립트. DEPLOY_LIGHTSAIL 기본값 false.')
check.setDisabled(false)
check.save()
println('Configured: dva-ci -> develop-backend (disabled until Linux pipeline is merged); validation job ready.')
