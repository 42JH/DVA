
pipeline {
    agent any

    options {
        skipDefaultCheckout(true)
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '5', artifactNumToKeepStr: '2'))
    }

    parameters {
        booleanParam(name: 'DEPLOY_LIGHTSAIL', defaultValue: false,
            description: '체크하면 빌드·검증 후 Lightsail에 파일 전송 및 배포합니다. 기본값은 빌드만 수행합니다.')
    }

    stages {
        stage('Checkout') {
            steps {
                echo 'GitLab 저장소에서 코드 가져오기'
                checkout scm
                script {
                    env.SOURCE_COMMIT = sh(script: 'git rev-parse HEAD', returnStdout: true).trim()
                    env.RELEASE_VERSION = "${env.SOURCE_COMMIT.take(12)}-${env.BUILD_NUMBER}"
                }
            }
        }

        stage('Verify') {
            steps {
                script {
                    def files = [
                        'README.md',
                        'compose.yaml',
                        'backend/Dockerfile',
                        'ai/Dockerfile',
                        'compose.prod.yaml',
                        'infra/nginx/default.prod.conf',
                        'infra/deploy/package.ps1',
                        'infra/deploy/deploy.sh',
                        'infra/deploy/upload.ps1',
                        'infra/deploy/known_hosts'
                    ]

                    files.each { file ->
                        if (!fileExists(file)) {
                            error "파일을 찾을 수 없습니다: ${file}"
                        }
                    }
                }

                echo '프로젝트 기본 구조 검증 성공'
            }
        }
        
        stage('Build Backend') {
            steps {
                nodejs(nodeJSInstallationName: 'node24') {
                    dir('backend') {
                        echo 'Node.js 버전 확인'
                        sh 'node --version'

                        echo '의존성 설치'
                        sh 'npm ci'

                        echo 'NestJS 빌드'
                        sh 'npm run build'
                    }
                }
            }
        }

        
        stage('Windows Release') {
            agent {
                label 'docker-builder'
            }

            stages {
                stage('Build and Package Images') {
                    steps {
                        checkout scm
                        powershell '''
                            $ErrorActionPreference = 'Stop'
                            git checkout --detach $env:SOURCE_COMMIT
                            if ($LASTEXITCODE -ne 0) { throw 'Cannot check out the verified commit.' }
                            & ./infra/deploy/package.ps1 -Version $env:RELEASE_VERSION
                        '''
                        archiveArtifacts artifacts: ".deploy/${env.RELEASE_VERSION}/**", onlyIfSuccessful: true
                    }
                }

                stage('Deploy to Lightsail') {
                    when {
                        expression { params.DEPLOY_LIGHTSAIL }
                    }
                    options {
                        timeout(time: 15, unit: 'MINUTES')
                    }
                    steps {
                        withCredentials([sshUserPrivateKey(credentialsId: 'dva-lightsail-ssh',
                            keyFileVariable: 'LIGHTSAIL_SSH_KEY', usernameVariable: 'LIGHTSAIL_SSH_USER')]) {
                            powershell '''
                                $ErrorActionPreference = 'Stop'
                                & ./infra/deploy/upload.ps1 -Version $env:RELEASE_VERSION `
                                    -IdentityFile $env:LIGHTSAIL_SSH_KEY -SshUser $env:LIGHTSAIL_SSH_USER
                            '''
                        }
                    }
                }
            }
        }
    }

    post {
        success {
            echo 'Dva CI 파이프라인 성공'
        }
        failure {
            echo 'Dva CI 파이프라인 실패'
        }
    }
}
