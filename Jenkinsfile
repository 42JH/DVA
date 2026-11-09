pipeline {
    agent {
        node {
            label 'linux-docker-builder'
            // Keep Git locks and interrupted checkouts outside every later build.
            customWorkspace "workspace/${env.JOB_NAME}@build-${env.BUILD_NUMBER}"
        }
    }
    options {
        skipDefaultCheckout(true)
        disableConcurrentBuilds()
        timeout(time: 40, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '5', artifactNumToKeepStr: '2'))
    }
    parameters {
        booleanParam(name: 'DEPLOY_LIGHTSAIL', defaultValue: false,
            description: '수동 빌드의 배포 선택입니다. develop-backend 웹훅 빌드는 검증 성공 후 자동 배포합니다.')
        booleanParam(name: 'FULL_BACKEND_TESTS', defaultValue: false,
            description: '변경 범위와 관계없이 백엔드 전체 회귀와 인프라 검증을 실행합니다.')
    }
    stages {
        stage('Checkout') {
            steps {
                script {
                    def source = checkout scm
                    env.SOURCE_BRANCH = source.GIT_BRANCH ?: ''
                    env.SOURCE_COMMIT = sh(script: 'git rev-parse HEAD', returnStdout: true).trim()
                    env.CI_BASE_COMMIT = source.GIT_PREVIOUS_SUCCESSFUL_COMMIT ?: ''
                    env.RELEASE_VERSION = "${env.SOURCE_COMMIT.take(12)}-${env.BUILD_NUMBER}"
                    def selection = sh(script: 'node infra/jenkins/monolith-changes.cjs', returnStdout: true).trim()
                    assert selection ==~ /(?:true|false),(?:true|false),(?:true|false),[a-z_]+,[a-z]+(?:\+[a-z]+)*/
                    def checks = selection.split(',')
                    env.CHECK_BACKEND = checks[0]
                    env.CHECK_OBSERVABILITY = checks[1]
                    env.CHECK_PAYMENT_DEMO = checks[2]
                    env.BACKEND_TEST_PROFILE = checks[4]
                    env.CI_DOCUMENTATION_ONLY = (checks[3] == 'documentation_only').toString()
                    env.CHECK_DEPLOY_REGRESSIONS = ((checks[3] != 'changed_paths' && checks[3] != 'documentation_only') || params.FULL_BACKEND_TESTS).toString()
                    if (params.FULL_BACKEND_TESTS) {
                        env.CHECK_BACKEND = 'true'
                        env.CHECK_OBSERVABILITY = 'true'
                        env.CHECK_PAYMENT_DEMO = 'true'
                        env.BACKEND_TEST_PROFILE = 'full'
                    }
                    env.SHOULD_DEPLOY = (sh(script: "bash infra/deploy/should-deploy.sh '${params.DEPLOY_LIGHTSAIL}'", returnStatus: true) == 0).toString()
                    if (env.SHOULD_DEPLOY == 'true' && env.CI_DOCUMENTATION_ONLY == 'true') {
                        env.CHECK_BACKEND = 'true'
                        env.BACKEND_TEST_PROFILE = 'full'
                    }
                    env.BACKEND_RELEASE_IMAGE = (env.SHOULD_DEPLOY == 'true' && env.CHECK_BACKEND == 'true') ? "dva-backend:${env.RELEASE_VERSION}" : ''
                    echo "CI selection: ${selection}; effective backend profile: ${env.BACKEND_TEST_PROFILE}; deploy regressions: ${env.CHECK_DEPLOY_REGRESSIONS}"
                }
            }
        }
        stage('Verify') {
            steps {
                sh '''
                    set -eu
                    test -f backend/package-lock.json
                    test -f compose.prod.yaml
                    bash -n infra/deploy/package.sh infra/deploy/upload.sh infra/deploy/deploy.sh infra/deploy/should-deploy.sh
                    sh -n infra/database/migrate.sh
                    if [ "$CHECK_DEPLOY_REGRESSIONS" = 'true' ]; then
                        bash infra/deploy/test-deploy-trigger.sh
                        bash infra/deploy/test-deploy.sh
                        bash infra/deploy/test-linux-release.sh
                    fi
                    node --test infra/jenkins/test-monolith-ci.cjs
                    node --version
                    docker version
                '''
            }
        }
        stage('Backend checks') {
            when { expression { env.CHECK_BACKEND == 'true' } }
            steps {
                sh 'node backend/scripts/check.cjs'
            }
        }
        stage('Observability checks') {
            when { expression { env.CHECK_OBSERVABILITY == 'true' } }
            steps {
                sh 'bash -n infra/observability/deploy.sh'
                sh 'node infra/observability/test.mjs'
            }
        }
        stage('Payment demo checks') {
            when { expression { env.CHECK_PAYMENT_DEMO == 'true' } }
            steps {
                sh 'node infra/payment-test/check.mjs'
            }
        }
        stage('Build and Package Images') {
            when { expression { env.SHOULD_DEPLOY == 'true' } }
            steps {
                sh 'bash infra/deploy/package.sh "$RELEASE_VERSION" "$BACKEND_RELEASE_IMAGE"'
                archiveArtifacts artifacts: ".deploy/${env.RELEASE_VERSION}/**", onlyIfSuccessful: true
            }
        }
        stage('Verify Deployment Access') {
            when { expression { env.SHOULD_DEPLOY == 'true' } }
            steps {
                withCredentials([sshUserPrivateKey(credentialsId: 'dva-lightsail-ssh',
                    keyFileVariable: 'LIGHTSAIL_SSH_KEY', usernameVariable: 'LIGHTSAIL_SSH_USER')]) {
                    sh 'bash infra/deploy/upload.sh "$RELEASE_VERSION" "$LIGHTSAIL_SSH_KEY" "$LIGHTSAIL_SSH_USER" --verify-only'
                }
            }
        }
        stage('Deploy to Lightsail') {
            when { expression { env.SHOULD_DEPLOY == 'true' } }
            options { timeout(time: 15, unit: 'MINUTES') }
            steps {
                withCredentials([sshUserPrivateKey(credentialsId: 'dva-lightsail-ssh',
                    keyFileVariable: 'LIGHTSAIL_SSH_KEY', usernameVariable: 'LIGHTSAIL_SSH_USER')]) {
                    sh 'bash infra/deploy/upload.sh "$RELEASE_VERSION" "$LIGHTSAIL_SSH_KEY" "$LIGHTSAIL_SSH_USER"'
                }
            }
        }
    }
    post {
        success { echo 'Dva Linux CI 파이프라인 성공' }
        failure { echo 'Dva Linux CI 파이프라인 실패' }
        cleanup {
            script {
                if (!pwd().endsWith("/${env.JOB_NAME}@build-${env.BUILD_NUMBER}")) {
                    error('Refusing to clean a workspace outside this build')
                }
                deleteDir()
            }
        }
    }
}
