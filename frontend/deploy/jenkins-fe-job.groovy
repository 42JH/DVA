// 젠킨스 관리 → Script Console에서 한 번 실행 — 프론트 CI/CD Job 'dva-fe'를 만듦 (이미 있으면 설정만 다시 맞춤)
// 백엔드 Job과 같은 GitLab 읽기 자격 증명(gitlab-dva-readonly)을 씀. 비밀값을 출력하지 않음
// 만든 뒤 첫 빌드를 한 번 돌림 → 그때 frontend/Jenkinsfile의 pollSCM(2분마다 develop-fe 확인)이 등록됨
import hudson.plugins.git.BranchSpec
import hudson.plugins.git.GitSCM
import jenkins.model.Jenkins
import org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition
import org.jenkinsci.plugins.workflow.job.WorkflowJob

// 저장소 주소는 붙여 넣기 전에 채움 (코드에 남기지 않음)
def repoUrl = ''
assert repoUrl : 'repoUrl(GitLab 저장소 주소)을 채운 뒤 실행하세요'
def jenkins = Jenkins.get()
def name = 'dva-fe'
def scm = new GitSCM(
    GitSCM.createRepoList(repoUrl, 'gitlab-dva-readonly'),
    [new BranchSpec('*/develop-fe')],
    null, null, [])
def flow = new CpsScmFlowDefinition(scm, 'frontend/Jenkinsfile')
flow.lightweight = true

def job = jenkins.getItem(name) ?: jenkins.createProject(WorkflowJob, name)
job.definition = flow
job.description = '관리자 웹(frontend) — develop-fe 변경을 2분마다 확인해 린트 · 빌드 · Lightsail 배포. 단계는 frontend/Jenkinsfile'
job.save()
job.scheduleBuild2(0)
println "준비됨: ${job.absoluteUrl} (첫 빌드 시작)"
