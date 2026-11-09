import groovy.json.JsonOutput
import jenkins.model.Jenkins
import hudson.model.Result
import org.jenkinsci.plugins.scriptsecurity.scripts.ScriptApproval
import org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition
import org.jenkinsci.plugins.workflow.job.WorkflowJob
import org.jenkinsci.plugins.workflow.support.steps.build.RunWrapper
import java.util.concurrent.TimeUnit

// Init script for a disposable, network-isolated Jenkins; never mount a real home.
assert System.getenv('MSA_JENKINS_SANDBOX_TEST') == '1'
def jenkins = Jenkins.get()
assert jenkins.items.empty
assert ScriptApproval.get().approvedSignatures.length == 0
jenkins.numExecutors = 1
def before = new File('/test-input/Jenkinsfile.before').getText('UTF-8')
def current = new File('/test-input/Jenkinsfile').getText('UTF-8')
def scopes = ['database', 'operations', 'customer', 'consultation', 'order', 'events', 'deployment']
def report = [passed: false, jenkins: Jenkins.VERSION, cases: [], plugins: [:]]
jenkins.pluginManager.plugins.each { report.plugins[it.shortName] = [version: it.version, active: it.active] }
def artifacts = new File('/test-results')
artifacts.mkdirs()
def save = { new File(artifacts, 'sandbox.json').text = JsonOutput.prettyPrint(JsonOutput.toJson(report)) + '\n' }
def helpers = { source ->
    def end = source.indexOf('\npipeline {')
    assert end > 0
    source.substring(0, end)
}
def restore = { source ->
    def lines = source.readLines().findAll { it.trim().startsWith('history.each {') }
    assert lines.size() == 1
    lines[0].trim()
}
def prepare = '''
    deleteDir()
    sh ''' + "'''" + '''
        set -eu
        mkdir -p msa/.ci-source/msa/parity msa-release
        cp /test-input/ci_verification.py /test-input/ci_images.py msa/.ci-source/msa/parity/
        ln -s "$PWD/msa-release" msa/.ci-source/msa-release
        git init -q
        git -c user.name=fixture -c user.email=fixture@example.invalid commit -q --allow-empty -m fixture
    ''' + "'''" + '''
    writeFile file: 'msa/.ci-source/msa/liquibase/verification.json', text: '{"passed":true,"imageId":null}'
    ['operations', 'customer', 'consultation', 'order'].each { scope ->
        writeFile file: "msa/.ci-source/msa/liquibase/verification-logs/${scope}/verification.json", text: '{"passed":true}'
    }
'''
Thread.start {
    int exitCode = 1
    try {
        while (jenkins.initLevel != hudson.init.InitMilestone.COMPLETED) { Thread.sleep(100) }
        def job = jenkins.createProject(WorkflowJob, 'msa-sandbox-probe')
        def run = { name, source, body, expected, message ->
            job.definition = new CpsFlowDefinition(helpers(source) + '\nnode {\n' + body + '\n}', true)
            job.save()
            def build = job.scheduleBuild2(0).get(90, TimeUnit.SECONDS)
            def log = build.getLog(2000).join('\n')
            new File(artifacts, name + '.log').text = log + '\n'
            report.cases << [name: name, build: build.number, result: build.result.toString()]
            save()
            assert build.result == expected: "${name}: ${log}"
            assert log.contains(message): "${name}: missing ${message}"
            build
        }
        def rejected = 'Scripts not permitted to use staticMethod org.codehaus.groovy.runtime.DefaultGroovyMethods putAt'
        run('before-record', before, prepare + "recordVerification('deployment')", Result.FAILURE, rejected)
        def record = prepare + scopes.collect { "recordVerification('${it}')" }.join('\n') + '''
            sleep time: 1, unit: 'SECONDS'
            sh 'test -n "$MSA_VERIFIED_DEPLOYMENT" && test -n "$MSA_VERIFIED_DATABASE"'
            error('fixture: later rollout failed')
        '''
        def passedChecks = run('after-record-later-failure', current, record, Result.FAILURE, 'fixture: later rollout failed')
        def expected = scopes.collectEntries { scope ->
            def key = 'MSA_VERIFIED_' + scope.toUpperCase()
            def value = new RunWrapper(passedChecks, false).getBuildVariables()[key]
            assert value ==~ /[0-9a-f]{40}:2/
            [(key): value]
        }
        run('before-restore', before, 'def history = verificationHistory()\n' + restore(before), Result.FAILURE, rejected)
        def carry = 'def history = verificationHistory()\n' + restore(current) + '\n' + '''
            sleep time: 1, unit: 'SECONDS'
            sh 'test -n "$MSA_VERIFIED_DEPLOYMENT" && test -n "$MSA_VERIFIED_DATABASE"'
            echo 'verification history restored'
        '''
        def restored = run('after-restore', current, carry, Result.SUCCESS, 'verification history restored')
        expected.each { key, value -> assert new RunWrapper(restored, false).getBuildVariables()[key] == value }
        assert ScriptApproval.get().approvedSignatures.length == 0
        report.passed = true
        report.restored = expected
        exitCode = 0
    } catch (Throwable failure) {
        report.error = failure.toString()
        failure.printStackTrace()
    } finally {
        save()
        System.exit(exitCode)
    }
}
