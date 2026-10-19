
pipeline {
    agent any

    options {
        skipDefaultCheckout(true)
    }

    stages {
        stage('Checkout') {
            steps {
                echo 'GitLab 저장소에서 코드 가져오기'
                checkout scm
            }
        }

        stage('Verify') {
            steps {
                script {
                    def files = [
                        'README.md',
                        'compose.yaml',
                        'backend/Dockerfile',
                        'ai/Dockerfile'
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
