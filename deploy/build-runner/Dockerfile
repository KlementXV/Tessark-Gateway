FROM quay.io/buildah/stable@sha256:ddc2141c484387e6c71bc3a42c24875d3a340582b96a3f2693de7138092c4107
RUN dnf -y install python3 git && dnf clean all
COPY runner.py /usr/local/bin/tessark-build
ENTRYPOINT ["python3", "/usr/local/bin/tessark-build"]
